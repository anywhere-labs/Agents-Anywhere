// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/history.py @98dd0e6e5 (history parsing)
//
// Read-only parsing of Pi's JSONL native history: never imports or runs Pi, its extensions or any config code, and
// never writes the source file.
//
// Item IDs follow the shared identity rules (domain/identity `piHistoryItemId`), so rereading the same native record
// yields the same ID. Records are first turned into intermediate items shaped like Timeline items, then translated
// into the port's HistoryItem events.

import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

import type { AttachmentInfo, HistoryItem, HistoryWindow, NativeHistoryPage } from '../../../application/ports/runtime-session.js'
import { piHistoryItemId, type JsonValue } from '../../../domain/identity/index.js'
import { fail } from '../../acp/errors.js'
import { within } from './files.js'

export const MAX_HISTORY_BYTES = 128 * 1024 * 1024

type Entry = { readonly [key: string]: JsonValue }

function record(value: JsonValue | undefined): Entry {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function textContent(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.filter(block => record(block).type === 'text').map(block => String(record(block).text ?? '')).join('\n')
  }
  return ''
}

function truncate(text: string, codePoints: number): string {
  const chars = Array.from(text)
  return chars.length > codePoints ? chars.slice(0, codePoints).join('') : text
}

export class PiHistory {
  constructor(
    readonly path: string,
    readonly header: Entry,
    readonly entries: readonly Entry[],
    /** `sha256:<digest of the source file bytes>`; the same format the SDK bridge uses to verify writes. */
    readonly revision: string,
    /** The file did not change while being read, every line parsed, and item IDs are unique. */
    readonly complete: boolean,
  ) {}

  get nativeId(): string {
    return String(this.header.id)
  }

  get cwd(): string {
    return typeof this.header.cwd === 'string' ? this.header.cwd : ''
  }

  get version(): JsonValue | undefined {
    return this.header.version
  }

  get title(): string {
    for (const entry of [...this.entries].reverse()) {
      if (entry.type === 'session_info' && entry.name) return truncate(String(entry.name), 4096)
    }
    for (const entry of this.entries) {
      const message = record(entry.message)
      if (message.role !== 'user') continue
      const text = textContent('aaDisplayText' in message ? message.aaDisplayText : message.content)
      if (text) return truncate(text, 160)
    }
    return 'Pi 历史会话'
  }

  get createdAt(): string | undefined {
    return typeof this.header.timestamp === 'string' ? this.header.timestamp : undefined
  }

  get updatedAt(): string | undefined {
    for (const entry of [...this.entries].reverse()) if (typeof entry.timestamp === 'string' && entry.timestamp) return entry.timestamp
    return this.createdAt
  }

  /** A session AA has sent messages in (by any Connector version): its user messages carry AA message IDs. */
  get ownedByAgentsAnywhere(): boolean {
    return this.entries.some(entry => typeof record(entry.message).aaClientMessageId === 'string')
  }

  /** Can be handed to Pi to continue writing: complete, format version 3, and the working directory still exists. */
  requireResumable(): void {
    if (!this.complete) fail('pi_history_incomplete', '原生历史正在写入或存在损坏记录，请稍后重试。')
    if (this.header.version !== 3) fail('pi_history_migration_required', '此历史需要格式迁移，当前仅开放浏览，未修改源文件。')
    let directory = false
    try {
      directory = isAbsolute(this.cwd) && statSync(this.cwd).isDirectory()
    } catch {
      directory = false
    }
    if (!directory) fail('pi_workspace_missing', '原会话的项目工作目录不存在或无效。')
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true })

/** Reads one history file; it must resolve inside some source directory (symlinks cannot escape a source). */
export async function readPiHistory(path: string, roots: readonly string[]): Promise<PiHistory> {
  let resolved: string
  try {
    resolved = await realpath(path)
  } catch {
    fail('pi_source_missing', '原生历史来源暂时不可用。')
  }
  const sources: string[] = []
  for (const root of roots) {
    try {
      sources.push(await realpath(root))
    } catch {
      // missing source
    }
  }
  if (!sources.some(root => within(resolved, root))) fail('pi_history_outside_source', '历史位置已超出配置的来源目录。')
  const handle = await open(resolved, 'r')
  let data: Buffer
  let complete: boolean
  try {
    const before = await handle.stat({ bigint: true })
    if (before.size > BigInt(MAX_HISTORY_BYTES)) fail('pi_history_too_large', '历史文件超过单文件读取上限。')
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let offset = 0
    for (;;) {
      if (offset >= buffer.length) break
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    data = buffer.subarray(0, offset)
    const after = await handle.stat({ bigint: true })
    complete = before.size === after.size && before.mtimeNs === after.mtimeNs && offset === Number(before.size)
  } finally {
    await handle.close()
  }
  const entries: Entry[] = []
  const lines = splitLines(data)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!
    if (raw.toString('latin1').trim() === '') continue
    try {
      const value = JSON.parse(decoder.decode(raw)) as JsonValue
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an entry')
      entries.push(value)
    } catch {
      complete = false
      if (index === lines.length - 1) break
    }
  }
  const header = entries[0]
  if (header === undefined || header.type !== 'session' || typeof header.id !== 'string') fail('pi_history_invalid', '文件没有有效的 Pi 原生会话头。')
  const ids = entries.slice(1).map(entry => entry.id).filter((id): id is string => typeof id === 'string')
  if (ids.length !== new Set(ids).size) complete = false
  return new PiHistory(resolved, header, entries.slice(1), `sha256:${createHash('sha256').update(data).digest('hex')}`, complete)
}

/** Splits on \r\n, \r and \n (like `bytes.splitlines()`), without line endings. */
function splitLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index]
    if (byte !== 10 && byte !== 13) continue
    lines.push(data.subarray(start, index))
    if (byte === 13 && data[index + 1] === 10) index += 1
    start = index + 1
  }
  if (start < data.length) lines.push(data.subarray(start))
  return lines
}

// ---------------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------------

export interface PiTimelineItem {
  readonly id: string
  readonly type: 'message' | 'tool'
  readonly role: 'user' | 'assistant' | 'tool'
  status: 'done' | 'failed' | 'cancelled' | 'pending'
  readonly content: Record<string, JsonValue>
  readonly source: Record<string, JsonValue>
  readonly orderSeq: number
}

/** Keeps the whole entry tree (branches and compactions appear as their original nodes); each native record becomes one or more items. */
export function piTimeline(history: PiHistory, sessionId: string, runtime = 'pi'): PiTimelineItem[] {
  const result: PiTimelineItem[] = []
  const tools = new Map<string, PiTimelineItem>()
  history.entries.forEach((entry, entryIndex) => {
    const add = (suffix: string | number, type: PiTimelineItem['type'], role: PiTimelineItem['role'], content: Record<string, JsonValue>, status: PiTimelineItem['status'] = 'done'): PiTimelineItem => {
      const source: Record<string, JsonValue> = {
        runtime, sessionId: history.nativeId, itemId: entry.id ?? null, itemType: entry.type ?? null, event: 'pi.native_entry',
        derivedKey: String(suffix), nativeSessionId: history.nativeId, nativeEntryId: entry.id ?? null, parentId: entry.parentId ?? null,
        timestamp: entry.timestamp ?? null, origin: 'pi_native_history',
        ...(content.clientMessageId ? { clientMessageId: content.clientMessageId } : {}),
      }
      const item: PiTimelineItem = { id: piHistoryItemId(sessionId, entry, entryIndex, suffix), type, role, status, content, source, orderSeq: result.length + 1 }
      result.push(item)
      return item
    }
    const kind = entry.type
    const message = entry.message
    if (kind === 'message' && message !== null && typeof message === 'object' && !Array.isArray(message)) {
      const role = message.role
      let blocks: JsonValue | undefined = 'content' in message ? message.content : []
      if (role === 'user' || role === 'assistant' || role === 'custom') {
        // The SDK text carries execution resource paths; messages sent by AA keep their original display text.
        if (role === 'user' && typeof message.aaDisplayText === 'string') blocks = [{ type: 'text', text: message.aaDisplayText }]
        if (typeof blocks === 'string') blocks = [{ type: 'text', text: blocks }]
        if (!Array.isArray(blocks)) return
        blocks.forEach((raw, index) => {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
          const block = raw
          if (block.type === 'text' || block.type === 'thinking' || block.type === 'image') {
            const thinking = block.type === 'thinking'
            const fallback = block.type === 'image' ? '[图片]' : ''
            const content: Record<string, JsonValue> = {
              kind: 'markdown', format: 'markdown', isThinking: thinking,
              text: (thinking ? block.thinking : block.text) ?? fallback,
            }
            if (message.aaClientMessageId) content.clientMessageId = message.aaClientMessageId
            // An empty list does not count as having attachments.
            if (role === 'user' && index === 0 && Array.isArray(message.aaAttachments) && message.aaAttachments.length > 0) content.attachments = message.aaAttachments
            add(index, 'message', role === 'user' ? 'user' : 'assistant', content, messageStatus(message))
          } else if (block.type === 'toolCall') {
            const args = block.arguments ?? {}
            const bash = block.name === 'bash'
            const content: Record<string, JsonValue> = {
              kind: bash ? 'command' : 'tool_call', title: block.name ?? 'tool', toolCallId: block.id ?? null, rawInput: args,
              ...(bash && args !== null && typeof args === 'object' && !Array.isArray(args) ? { command: args.command ?? null } : {}),
            }
            tools.set(String(block.id), add(index, 'tool', 'tool', content, 'pending'))
          }
        })
        // When the model errors, Pi records the reason in errorMessage (the body is often empty): emit a separate error
        // notice so a failed turn is not invisible in the history. The derived key `error` cannot collide with content block indexes.
        const failure = role === 'assistant' && message.stopReason === 'error' && typeof message.errorMessage === 'string' ? message.errorMessage.trim() : ''
        if (failure) add('error', 'message', 'assistant', { kind: 'markdown', format: 'markdown', text: failure, nativeEntryType: 'error' }, 'failed')
      } else if (role === 'toolResult') {
        const item = tools.get(String(message.toolCallId)) ?? add('result', 'tool', 'tool', { kind: 'tool_call', title: message.toolName ?? 'tool' })
        item.content.output = textContent(blocks)
        item.content.rawOutput = { content: blocks ?? null, details: message.details ?? null }
        item.status = message.isError ? 'failed' : 'done'
      } else if (role === 'bashExecution') {
        add('bash', 'tool', 'tool', {
          kind: 'command', title: 'bash', command: message.command ?? null, output: message.output ?? '', exitCode: message.exitCode ?? null,
        }, message.exitCode ? 'failed' : 'done')
      }
    } else if (kind === 'compaction' || kind === 'branch_summary' || kind === 'custom_message') {
      const text = (typeof entry.summary === 'string' && entry.summary) || textContent(entry.content)
      if (text) add(kind, 'message', 'assistant', { kind: 'markdown', format: 'markdown', text, nativeEntryType: kind })
    }
  })
  return result
}

/** A message the model errored on counts as failed; an interrupted one counts as cancelled. */
function messageStatus(message: Entry): PiTimelineItem['status'] {
  return message.stopReason === 'error' ? 'failed' : message.stopReason === 'aborted' ? 'cancelled' : 'done'
}

/** `aaAttachments` in native records (the Timeline attachment shape); unrecognized entries are skipped. */
export function attachmentInfos(value: JsonValue | undefined): AttachmentInfo[] {
  if (!Array.isArray(value)) return []
  const infos: AttachmentInfo[] = []
  for (const raw of value) {
    const entry = record(raw)
    if (typeof entry.fileId !== 'string' || entry.fileId === '') continue
    infos.push({
      fileId: entry.fileId,
      name: typeof entry.name === 'string' ? entry.name : entry.fileId,
      mediaType: typeof entry.mediaType === 'string' ? entry.mediaType : 'application/octet-stream',
      ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
      ...(typeof entry.sha256 === 'string' ? { sha256: entry.sha256 } : {}),
    })
  }
  return infos
}

function jsonText(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** Intermediate items -> port events (all marked replay). Tool items carry their final state, followed by a tool.updated when there is output. */
export function piHistoryEvents(items: readonly PiTimelineItem[]): HistoryItem[] {
  const events: HistoryItem[] = []
  for (const item of items) {
    const content = item.content
    if (item.type === 'message') {
      if (content.nativeEntryType === 'compaction') {
        events.push({ type: 'notice', itemId: item.id, level: 'info', kind: 'compact', text: jsonText(content.text), replay: true })
        continue
      }
      if (content.nativeEntryType === 'error') {
        events.push({ type: 'notice', itemId: item.id, level: 'error', kind: 'error', text: jsonText(content.text), replay: true })
        continue
      }
      const role = item.role === 'user' ? 'user' : content.isThinking === true ? 'reasoning' : 'assistant'
      const clientMessageId = typeof content.clientMessageId === 'string' ? content.clientMessageId : undefined
      const attachments = attachmentInfos(content.attachments)
      events.push({
        type: 'message.completed', itemId: item.id, role, text: jsonText(content.text), ...(clientMessageId ? { clientMessageId } : {}),
        ...(attachments.length > 0 ? { timelineAttachments: attachments } : {}),
        ...(item.status === 'failed' || item.status === 'cancelled' ? { status: item.status } : {}),
        replay: true,
      })
      continue
    }
    const command = content.kind === 'command'
    const status = item.status
    const input: JsonValue | undefined = content.rawInput ?? (command && content.command !== undefined ? { command: content.command } : undefined)
    events.push({
      type: 'tool.started', itemId: item.id, toolCallId: typeof content.toolCallId === 'string' ? content.toolCallId : item.id,
      kind: command ? 'command' : 'other', title: jsonText(content.title) || 'tool', status, ...(input !== undefined ? { input } : {}), replay: true,
    })
    if (content.output !== undefined) {
      const output = jsonText(content.output)
      events.push({
        type: 'tool.updated', itemId: item.id, toolCallId: typeof content.toolCallId === 'string' ? content.toolCallId : item.id, status,
        output: content.rawOutput ?? (command ? { output, exitCode: content.exitCode ?? null } : output),
        ...(output ? { content: [{ type: 'text', text: output }] } : {}), replay: true,
      })
    }
  }
  return events
}

/**
 * History window: pages by intermediate item (a tool's start and result are never split). The cursor is an item
 * index; without one the newest page is returned, `older` takes items before the cursor and `newer` after it.
 */
export function piHistoryPage(items: readonly PiTimelineItem[], window: HistoryWindow): NativeHistoryPage {
  const limit = window.limit > 0 ? window.limit : items.length
  const cursor = window.cursor !== undefined && /^\d+$/.test(window.cursor) ? Math.min(Number(window.cursor), items.length) : undefined
  let start: number
  let end: number
  if (cursor !== undefined && window.direction === 'newer') {
    start = cursor
    end = Math.min(items.length, cursor + limit)
  } else {
    end = cursor ?? items.length
    start = Math.max(0, end - limit)
  }
  return {
    items: piHistoryEvents(items.slice(start, end)),
    ...(start > 0 ? { olderCursor: String(start) } : {}),
    ...(end < items.length ? { newerCursor: String(end) } : {}),
  }
}
