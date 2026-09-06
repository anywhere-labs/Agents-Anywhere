import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { contentHash, itemId } from './identity.js'
import { enrichToolResult, parentToolItem, resultContent, toolContent } from './tools.js'
import { json, record, type Data, type ItemStatus, type ItemType, type TimelineItem } from './types.js'

const QUIET_EVENTS = new Set([
  'request/header', 'request/context', 'session/title', 'session/end-seed',
  'step/start', 'step/end', 'agent-preset/selected', 'permission/preset', 'sandbox/mode',
])

/** A pure raw-log fold. No Agent creation, file reads, or second history database. */
export function projectHistory(snapshot: SessionLogSnapshot, platformId: string): TimelineItem[] {
  const externalId = snapshot.session.id
  const items = new Map<string, TimelineItem>()
  const steps = new Map<string, number>()
  const drafts = new Map<string, Map<number, { block: ContentBlock, seq: number, event: SessionEvent }>>()
  let turnId: string | null = null
  let turnStart = -1

  function put(kind: string, key: string, event: SessionEvent, type: ItemType, status: ItemStatus,
    role: string | null, content: Data, index = 0, anchor = Number(event.seq)): TimelineItem {
    const id = itemId(externalId, kind, key)
    const previous = items.get(id)
    const value: TimelineItem = {
      id, sessionId: platformId, type, status, role, turnId: previous ? previous.turnId : turnId,
      // Fractional slots retain order under partial/final replay without a per-page counter.
      orderSeq: previous?.orderSeq ?? anchor * 1_000_000 + index,
      revision: Number(event.seq) + 1, contentHash: '', content,
      source: { runtime: 'dsh', sessionId: externalId, itemId: key, itemType: event.type,
        seq: previous?.source.seq ?? anchor, lastSeq: Number(event.seq), time: event.time },
    }
    value.contentHash = contentHash(value)
    items.set(id, value)
    return value
  }

  function tool(callId: string, name: string, args: unknown, event: SessionEvent, index = 0, anchor?: number) {
    const id = itemId(externalId, 'tool', callId)
    const old = items.get(id)
    return put('tool', callId, event, 'tool', old?.status ?? 'running', 'assistant', {
      ...old?.content, ...toolContent(name, args), callId,
    }, index, anchor)
  }

  function result(callId: string, blocks: unknown, failed: boolean, event: SessionEvent, meta?: unknown, error?: unknown) {
    const previous = items.get(itemId(externalId, 'tool', callId))
    put('tool', callId, event, 'tool', failed ? 'failed' : 'done', 'assistant',
      enrichToolResult({ ...(previous?.content ?? toolContent('tool', {})), callId, isError: failed,
        ...(error !== undefined ? { error: json(error) } : {}), ...resultContent(blocks) }, meta))
  }

  function block(block: ContentBlock, key: string, index: number, event: SessionEvent,
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

  for (const event of snapshot.events) {
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
        closed.contentHash = contentHash(closed)
        items.set(id, closed)
      }
      put('turn.end', String(turnStart), event, 'turn.end', status, 'system', { kind: 'turn_end', reason: json(reason) })
      turnId = null
    } else if (event.type === 'step/start') {
      steps.set(stepKey, Number(event.seq))
    } else if (event.type === 'user/message') {
      const message = event.data
      const role = message.source.kind === 'user' ? 'user' : 'system'
      message.content.forEach((value, i) => {
        const item = block(value, message.id, i, event, role, 'done')
        if (item) item.source = { ...item.source, messageSource: json(message.source) }
      })
    } else if (event.type === 'assistant/chunk') {
      const key = `${turnStart}:${steps.get(stepKey) ?? stepKey}`
      const values = drafts.get(key) ?? new Map()
      drafts.set(key, values)
      const chunk = event.data.chunk
      if (!('index' in chunk)) continue
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
        block(value, key, chunk.index, event, 'assistant', 'running', anchor)
      }
    } else if (event.type === 'assistant/message') {
      const key = `${turnStart}:${steps.get(stepKey) ?? stepKey}`
      const values = drafts.get(key)
      // Cancellation can discard undispatched tool blocks; they must not survive the final message.
      const finalCalls = new Set(event.data.message.content.flatMap(b => b.type === 'tool-call' ? [b.id] : []))
      for (const [index, value] of values ?? []) {
        if (value.block.type === 'tool-call' && !finalCalls.has(value.block.id)) {
          items.delete(itemId(externalId, 'tool', value.block.id))
        }
        if (index >= event.data.message.content.length && value.block.type !== 'tool-call') {
          const kind = value.block.type === 'reasoning' ? 'reasoning' : value.block.type === 'image' ? 'image' : 'message'
          items.delete(itemId(externalId, kind, `${key}:${index}`))
        }
      }
      event.data.message.content.forEach((value, i) => {
        const item = block(value, key, i, event, 'assistant', event.data.interrupted ? 'interrupted' : 'done', values?.get(i)?.seq)
        if (item) item.source = { ...item.source, messageId: event.data.message.id,
          provider: event.data.message.source.provider, model: event.data.message.source.model }
      })
    } else if (event.type === 'tool/call') {
      tool(event.data.callId, event.data.name, event.data.arguments, event)
    } else if (event.type === 'tool/result') {
      const value = event.data.message.content[0]
      result(value.toolCallId, value.content, value.isError === true || Boolean(event.data.error), event, event.data.meta, event.data.error)
    } else if (eventType === 'tool/code-dispatch-start' || eventType === 'tool/code-dispatch') {
      if (typeof data.subCallId !== 'string' || typeof data.name !== 'string') continue
      const item = tool(data.subCallId, data.name, data.arguments, event)
      item.content.parentItemId = parentToolItem(externalId, String(data.parentCallId))
      item.content.rootCallId = String(data.rootCallId)
      item.contentHash = contentHash(item)
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
    } else if (!QUIET_EVENTS.has(event.type)) {
      // Informational/plugin events are preserved as history, never actionable interaction notices.
      put('event', String(event.seq), event, 'system', 'done', 'system',
        { kind: 'notice', title: event.type, eventType: event.type, text: JSON.stringify(event.data, null, 2), details: json(event.data) })
    }
  }
  return [...items.values()].sort((a, b) => a.orderSeq - b.orderSeq || a.id.localeCompare(b.id))
}
