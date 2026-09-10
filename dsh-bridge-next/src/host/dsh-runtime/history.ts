import { setImmediate as yieldLoop } from 'node:timers/promises'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { receiptKey, type AttachmentSnapshot, type AttachmentReceipt } from './attachments.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { clientMessageId, contentHash, itemId } from './identity.js'
import { enrichToolResult, parentToolItem, resultContent, toolContent } from './tools.js'
import { json, record, type Data, type ItemStatus, type ItemType, type TimelineItem } from './types.js'

// Older persisted logs and fixtures can still carry the pre-rc.1 chunk vocabulary.
type LegacyChunk = { type: 'assistant/chunk', seq: SessionEvent['seq'], time: number,
  data: { turn: number, step: number, chunk: StreamChunk } }
type ProjectionEvent = SessionEvent | LegacyChunk

/** One deterministic projector shared by snapshots and the live event feed. */
export function createProjection(externalId: string, platformId: string) {
  let throughSeq = -1
  const changed = new Map<string, TimelineItem>()
  const removed = new Set<string>()
  const items = new Map<string, TimelineItem>()
  const steps = new Map<string, number>()
  const drafts = new Map<string, Map<number, { block: ContentBlock, seq: number, event: ProjectionEvent }>>()
  const pendingDrafts = new Map<string, Map<number, { block: ContentBlock, seq: number, event: ProjectionEvent }>>()
  function flushDrafts(): void {
    for (const [key, values] of pendingDrafts) for (const [index, value] of values) {
      block(value.block, key, index, value.event, 'assistant', 'running', value.seq)
    }
    pendingDrafts.clear()
  }
  let turnId: string | null = null
  let turnStart = -1
  let nextOrder = 0

  // The platform is the only reader of contentHash, so it is computed once per
  // drain/snapshot instead of on every streaming chunk. Canonical hashing walks
  // the whole content, and a streaming message produces far more chunks than
  // flush windows.
  const needsHash = new Set<string>()
  function flushHashes(): void {
    for (const id of needsHash) {
      const item = items.get(id)
      if (item) item.contentHash = contentHash(item)
    }
    needsHash.clear()
  }

  function put(kind: string, key: string, event: ProjectionEvent, type: ItemType, status: ItemStatus,
    role: string | null, content: Data, _index = 0, anchor = Number(event.seq)): TimelineItem {
    const id = itemId(externalId, kind, key)
    const previous = items.get(id)
    const value: TimelineItem = {
      id, sessionId: platformId, type, status, role, turnId: previous ? previous.turnId : turnId,
      // The same native replay assigns dense positions in history and live mode.
      // This stays compatible with the backend's existing INTEGER order column.
      orderSeq: previous?.orderSeq ?? ++nextOrder,
      revision: Number(event.seq) + 1, contentHash: '', content,
      source: { runtime: 'dsh', sessionId: externalId, itemId: key, itemType: event.type,
        seq: previous?.source.seq ?? anchor, lastSeq: Number(event.seq), time: event.time },
    }
    needsHash.add(id)
    items.set(id, value)
    changed.set(id, value)
    removed.delete(id)
    return value
  }

  function tool(callId: string, name: string, args: unknown, event: ProjectionEvent, index = 0, anchor?: number) {
    const id = itemId(externalId, 'tool', callId)
    const old = items.get(id)
    return put('tool', callId, event, 'tool', old?.status ?? 'running', 'assistant', {
      ...old?.content, ...toolContent(name, args), callId,
    }, index, anchor)
  }

  function result(callId: string, blocks: unknown, failed: boolean, event: ProjectionEvent, meta?: unknown, error?: unknown) {
    const previous = items.get(itemId(externalId, 'tool', callId))
    put('tool', callId, event, 'tool', failed ? 'failed' : 'done', 'assistant',
      enrichToolResult({ ...(previous?.content ?? toolContent('tool', {})), callId, isError: failed,
        ...(error !== undefined ? { error: json(error) } : {}), ...resultContent(blocks) }, meta))
  }

  function block(block: ContentBlock, key: string, index: number, event: ProjectionEvent,
    role: string, status: ItemStatus, anchor?: number) {
    switch (block.type) {
      case 'text':
        return put('message', `${key}:${index}`, event, role === 'system' ? 'system' : 'message', status, role,
          { kind: role === 'system' ? 'notice' : 'markdown', format: 'markdown', text: block.text }, index, anchor)
      case 'reasoning':
        return put('reasoning', `${key}:${index}`, event, 'system', status, 'assistant',
          { kind: 'reasoning', text: block.text }, index, anchor)
      case 'image':
        return put('image', `${key}:${index}`, event, 'message', status, role,
          { kind: 'text', format: 'text', text: '[图片暂不支持跨设备预览]', dshAttachment: json(block.attachment) }, index, anchor)
      case 'tool-call':
        return tool(block.id, block.name, block.arguments, event, index, anchor)
      case 'tool-result':
        result(block.toolCallId, block.content, block.isError === true, event)
        return
    }
  }

  function remove(id: string) {
    if (items.delete(id)) { changed.delete(id); removed.add(id) }
  }

  function apply(event: ProjectionEvent, receipt?: AttachmentReceipt, transient = false): void {
    if (!transient && Number(event.seq) <= throughSeq) return
    if (!transient && throughSeq >= 0 && Number(event.seq) !== throughSeq + 1) throw new Error('DSH event sequence gap')
    if (!transient) throughSeq = Number(event.seq)
    if (event.type !== 'assistant/chunk') flushDrafts()
    const data = record(event.data)
    const eventType: string = event.type
    const stepKey = `${String(data.turn)}:${String(data.step)}`
    if (event.type === 'turn/start') {
      turnStart = Number(event.seq)
      turnId = itemId(externalId, 'turn', String(turnStart))
      put('turn.start', String(turnStart), event, 'turn.start', 'done', 'system', { kind: 'turn_start', turn: event.data.turn })
    } else if (event.type === 'turn/end') {
      const reason = event.data.reason
      const status: ItemStatus = reason.kind === 'error' ? 'failed' :
        ['aborted', 'interrupted'].includes(reason.kind) ? 'interrupted' : 'done'
      for (const [id, item] of items) {
        if (item.turnId !== turnId || item.status !== 'running') continue
        const closed = { ...item, status: status === 'done' ? 'interrupted' as const : status,
          revision: Number(event.seq) + 1, source: { ...item.source, lastSeq: Number(event.seq) } }
        needsHash.add(id)
        items.set(id, closed)
        changed.set(id, closed)
      }
      put('turn.end', String(turnStart), event, 'turn.end', status, 'system', { kind: 'turn_end', reason: json(reason) })
      turnId = null
    } else if (event.type === 'step/start') {
      steps.set(stepKey, Number(event.seq))
    } else if (event.type === 'user/message') {
      const message = event.data
      if (message.source.kind !== 'user') return
      const rpcId = record(message.source).rpcId
      const clientId = (typeof rpcId === 'string' ? clientMessageId(externalId, rpcId) : undefined) ?? clientMessageId(externalId, message.id)
      const role = 'user'
      if (receipt?.platformId === platformId && receipt.attachments.length) {
        const item = put('message', `${message.id}:0`, event, 'message', 'done', role, {
          kind: 'markdown', format: 'markdown',
          text: message.content.filter(value => value.type === 'text').map(value => value.text).join('\n'),
          attachments: receipt.attachments.map(attachment => ({ ...attachment })),
        })
        item.source = { ...item.source, messageSource: json(message.source), ...(clientId ? { clientMessageId: clientId } : {}) }
        return
      }
      message.content.forEach((value, i) => {
        const item = block(value, message.id, i, event, role, 'done')
        if (item) item.source = { ...item.source, messageSource: json(message.source),
          ...(clientId ? { clientMessageId: clientId } : {}) }
      })
    } else if (event.type === 'assistant/chunk') {
      const key = `${turnStart}:${steps.get(stepKey) ?? stepKey}`
      const values = drafts.get(key) ?? new Map()
      drafts.set(key, values)
      const chunk = event.data.chunk
      if (!('index' in chunk)) return
      const previous = values.get(chunk.index)
      let value = previous?.block
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
        value = { type, text: (value?.type === type ? value.text : '') + chunk.text }
      } else if (chunk.type === 'tool-call-delta') {
        const old = value?.type === 'tool-call' ? value : undefined
        value = { type: 'tool-call', id: chunk.id, name: chunk.name ?? old?.name ?? 'tool',
          arguments: (old?.arguments ?? '') + (chunk.argumentsDelta ?? '') }
      } else if (chunk.type === 'block-end') value = chunk.block
      if (value) {
        const anchor = previous?.seq ?? Number(event.seq)
        values.set(chunk.index, { block: value, seq: anchor, event })
        const pending = pendingDrafts.get(key) ?? new Map()
        pending.set(chunk.index, { block: value, seq: anchor, event })
        pendingDrafts.set(key, pending)
      }
    } else if (event.type === 'assistant/attempt') {
      const key = `${turnStart}:${steps.get(stepKey) ?? stepKey}`
      for (const [index, value] of drafts.get(key) ?? []) {
        const kind = value.block.type === 'tool-call' ? 'tool' : value.block.type === 'reasoning' ? 'reasoning' : 'message'
        remove(itemId(externalId, kind, value.block.type === 'tool-call' ? value.block.id : `${key}:${index}`))
      }
      drafts.delete(key)
    } else if (event.type === 'assistant/message') {
      const key = `${turnStart}:${steps.get(stepKey) ?? stepKey}`
      const values = drafts.get(key)
      // Cancellation can discard undispatched tool blocks; they must not survive the final message.
      const finalCalls = new Set(event.data.message.content.flatMap(b => b.type === 'tool-call' ? [b.id] : []))
      for (const [index, value] of values ?? []) {
        if (value.block.type === 'tool-call' && !finalCalls.has(value.block.id)) {
          remove(itemId(externalId, 'tool', value.block.id))
        }
        if (index >= event.data.message.content.length && value.block.type !== 'tool-call') {
          const kind = value.block.type === 'reasoning' ? 'reasoning' : value.block.type === 'image' ? 'image' : 'message'
          remove(itemId(externalId, kind, `${key}:${index}`))
        }
      }
      event.data.message.content.forEach((value, i) => {
        const item = block(value, key, i, event, 'assistant', event.data.interrupted ? 'interrupted' : 'done', values?.get(i)?.seq)
        if (item) item.source = { ...item.source, messageId: event.data.message.id,
          provider: event.data.message.source.provider, model: event.data.message.source.model }
      })
      drafts.delete(key)
    } else if (event.type === 'tool/call') {
      tool(event.data.callId, event.data.name, event.data.arguments, event)
    } else if (event.type === 'tool/result') {
      const value = event.data.message.content[0]
      result(value.toolCallId, value.content, value.isError === true || Boolean(event.data.error), event, event.data.meta, event.data.error)
    } else if (eventType === 'tool/code-dispatch-start' || eventType === 'tool/code-dispatch') {
      if (typeof data.subCallId !== 'string' || typeof data.name !== 'string') return
      const item = tool(data.subCallId, data.name, data.arguments, event)
      item.content.parentItemId = parentToolItem(externalId, String(data.parentCallId))
      item.content.rootCallId = String(data.rootCallId)
      if (eventType === 'tool/code-dispatch') result(data.subCallId, data.content, data.isError === true, event)
    } else if (eventType === 'approval/asked' || eventType === 'approval/decided') {
      const key = String(data.id)
      const previous = items.get(itemId(externalId, 'approval', key))
      put('approval', key, event, 'tool', 'done', 'system', {
        ...previous?.content, kind: 'permission', title: '工具授权记录', readOnly: true,
        ...json(data) as Data,
      })
    } else if (String(event.type).startsWith('compaction/')) {
      put('event', String(event.seq), event, 'marker', 'done', 'system',
        { kind: 'compact', title: '上下文压缩', eventType: event.type, details: json(event.data) })
    }
    // Internal and unknown informational events deliberately produce no Timeline item.
  }
  return {
    apply,
    stream(turn: number, step: number, chunk: StreamChunk, time: number, cursor: number) {
      if (throughSeq > cursor) return // A baseline may already include the durable settlement.
      apply({ type: 'assistant/chunk', seq: throughSeq as SessionEvent['seq'], time,
        data: { turn, step, chunk } }, undefined, true)
    },
    get throughSeq() { return throughSeq },
    get dirty() { return pendingDrafts.size > 0 || changed.size > 0 || removed.size > 0 },
    snapshot: () => {
      flushDrafts()
      flushHashes()
      return [...items.values()].sort((a, b) => a.orderSeq - b.orderSeq || a.id.localeCompare(b.id))
    },
    drain() {
      flushDrafts()
      flushHashes()
      const delta = { items: [...changed.values()], removed: [...removed] }
      changed.clear(); removed.clear()
      return delta
    },
  }
}

export type SessionProjection = ReturnType<typeof createProjection>

export function projectHistory(snapshot: AttachmentSnapshot, platformId: string): TimelineItem[] {
  const projection = createProjection(snapshot.session.id, platformId)
  for (const event of snapshot.events) projection.apply(event, snapshot.attachmentReceipts?.[receiptKey(event) ?? ''])
  return projection.snapshot()
}

/** Bound replay slices so timers, control RPC and cancellation can run between them. */
export async function replayHistory(projection: SessionProjection, snapshot: AttachmentSnapshot, signal?: AbortSignal): Promise<void> {
  let deadline = performance.now() + 5
  for (let index = 0; index < snapshot.events.length; index++) {
    if (index % 128 === 0 && performance.now() >= deadline) {
      await yieldLoop(undefined, { signal })
      deadline = performance.now() + 5
    }
    signal?.throwIfAborted()
    const event = snapshot.events[index]!
    projection.apply(event, snapshot.attachmentReceipts?.[receiptKey(event) ?? ''])
  }
}

export async function projectHistoryAsync(snapshot: AttachmentSnapshot, platformId: string, signal?: AbortSignal): Promise<TimelineItem[]> {
  const projection = createProjection(snapshot.session.id, platformId)
  await replayHistory(projection, snapshot, signal)
  return projection.snapshot()
}
