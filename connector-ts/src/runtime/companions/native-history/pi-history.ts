// 只读解析 Pi 的 JSONL 原生历史：不导入、不运行 Pi、扩展或任何配置代码，从不写源文件。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/history.py
//
// 条目 ID 沿用 v2 规则（domain/identity `piHistoryItemId`），同一条原生记录重读后 ID 不变。
// 与 v2 的差别：v2 产出 Timeline 条目字典；这里先得到同形的中间条目，再翻译成端口的 HistoryItem 事件。

import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

import type { HistoryItem, HistoryWindow, NativeHistoryPage } from '../../../application/ports/runtime-session.js'
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
    /** `sha256:<源文件字节的摘要>`；与 SDK bridge 的写入校验同一格式。 */
    readonly revision: string,
    /** 读取期间文件没变、每行都能解析、条目 ID 不重复。 */
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

  /** AA（含 v2）发过消息的会话：用户消息上有 AA 的消息 ID。 */
  get ownedByAgentsAnywhere(): boolean {
    return this.entries.some(entry => typeof record(entry.message).aaClientMessageId === 'string')
  }

  /** 能交给 Pi 继续写：完整、格式版本 3、工作目录还在。 */
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

/** 读一个历史文件；文件必须解析到某个来源目录之内（符号链接不能逃出来源）。 */
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
      // 不存在的来源
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

/** Python `bytes.splitlines()`：按 \r\n、\r、\n 分行，不含行尾。 */
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
// 时间线（v2 `timeline`）
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

/** 保留整棵条目树（分支、压缩都按原节点出现），每条原生记录拆成一个或多个条目。 */
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
        // SDK 文本里带着执行资源路径；AA 发的消息保留它原来的显示文本。
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
            if (role === 'user' && index === 0 && message.aaAttachments) content.attachments = message.aaAttachments
            add(index, 'message', role === 'user' ? 'user' : 'assistant', content,
              message.stopReason === 'error' ? 'failed' : message.stopReason === 'aborted' ? 'cancelled' : 'done')
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

function jsonText(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** 中间条目 → 端口事件（全部标 replay）。工具条目给出最终状态；有输出时再跟一条 tool.updated。 */
export function piHistoryEvents(items: readonly PiTimelineItem[]): HistoryItem[] {
  const events: HistoryItem[] = []
  for (const item of items) {
    const content = item.content
    if (item.type === 'message') {
      if (content.nativeEntryType === 'compaction') {
        events.push({ type: 'notice', itemId: item.id, level: 'info', kind: 'compact', text: jsonText(content.text), replay: true })
        continue
      }
      const role = item.role === 'user' ? 'user' : content.isThinking === true ? 'reasoning' : 'assistant'
      const clientMessageId = typeof content.clientMessageId === 'string' ? content.clientMessageId : undefined
      events.push({ type: 'message.completed', itemId: item.id, role, text: jsonText(content.text), ...(clientMessageId ? { clientMessageId } : {}), replay: true })
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
 * 历史窗口：按中间条目分页（同一个工具的开始与结果不会被拆开）。游标是条目下标；不给时取最新一页，
 * `older` 取游标之前，`newer` 取游标之后。
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
