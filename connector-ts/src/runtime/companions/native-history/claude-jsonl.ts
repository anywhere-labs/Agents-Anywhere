// Claude 原生历史的只读读取：直接解析 Claude Code 的 JSONL（`~/.claude/projects/<目录>/<会话>.jsonl`）。
//
// 不能用 ACP `session/load` 浏览历史：claude-agent-acp 加载会话时会往 JSONL 末尾追加记录（S2 实测）。
// 条目 ID 沿用 v2 claude/sessions/reader.py（v2 用 Claude Agent SDK 的只读 getSessionMessages）：
// - 回合 ID：`claudeHistoryTurnId(会话, 开启回合的用户消息 uuid)`；
// - 用户消息：`claudeMessageItemId(会话, uuid)`；助手消息：`claudeMessageItemId(会话, API 消息 ID)`，
//   同一条 API 消息分在多行时合并成一个条目；思考块：`claudeSystemItemId`；工具：`claudeToolItemId(会话, tool_use id)`。

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { HistoryItem, ToolKind } from '../../../application/ports/runtime-session.js'
import {
  claudeHistoryTurnId,
  claudeMessageItemId,
  claudeSystemItemId,
  claudeToolItemId,
  type ClaudeSessionScope,
  type JsonValue,
} from '../../../domain/identity/index.js'

type Json = Record<string, unknown>

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
}

/** 在各项目目录里找 `<会话>.jsonl`。会话 ID 只允许安全字符，不会拼出目录之外的路径。 */
export async function findClaudeTranscript(nativeSessionId: string, projectsDir = claudeProjectsDir()): Promise<string | undefined> {
  if (!SESSION_ID.test(nativeSessionId)) return undefined
  let projects: string[]
  try {
    projects = await readdir(projectsDir)
  } catch {
    return undefined
  }
  for (const project of projects) {
    const file = join(projectsDir, project, `${nativeSessionId}.jsonl`)
    try {
      if ((await stat(file)).isFile()) return file
    } catch {
      // 不在这个项目里
    }
  }
  return undefined
}

const record = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {})

function claudeToolKind(name: string): ToolKind {
  switch (name) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'command'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'file_change'
    case 'Read':
      return 'read'
    case 'Glob':
    case 'Grep':
      return 'search'
    case 'WebFetch':
      return 'fetch'
    case 'WebSearch':
      return 'web_search'
    case 'Task':
    case 'Agent':
      return 'agent_call'
    default:
      return name.startsWith('mcp__') ? 'mcp' : 'other'
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(record).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => String(b.text)).join('\n')
}

/** 把一个 JSONL 文件投影成历史条目（从旧到新）。 */
export async function readClaudeTranscript(file: string, scope: ClaudeSessionScope): Promise<HistoryItem[]> {
  const items: HistoryItem[] = []
  const position = new Map<string, number>()
  const put = (item: HistoryItem) => {
    // 只合并消息（同一条 API 消息分多行写入）；工具的开始与结果是两个事件，都要保留。
    if (item.type !== 'message.completed') {
      items.push(item)
      return
    }
    const at = position.get(item.itemId)
    if (at === undefined) {
      position.set(item.itemId, items.length)
      items.push(item)
      return
    }
    const previous = items[at]!
    // 同一条 API 消息分多行写入：文本接起来（实时流也是按到达顺序拼接）。
    items[at] = previous.type === 'message.completed' ? { ...item, text: previous.text + item.text } : item
  }
  const external = scope.externalSessionId ?? scope.sessionId
  let turnSeed: string | undefined
  let turnIndex = 0
  let lineIndex = -1
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    lineIndex += 1
    if (line.trim() === '') continue
    let entry: Json
    try {
      entry = record(JSON.parse(line))
    } catch {
      continue
    }
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain === true || entry.isMeta === true) continue
    const message = record(entry.message)
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined
    if (entry.type === 'user') {
      const text = textOf(message.content)
      if (text !== '') {
        turnIndex += 1
        turnSeed = uuid ?? `${external}:${turnIndex}`
      }
      const turnId = claudeHistoryTurnId(external, turnSeed ?? uuid ?? `${external}:initial`)
      for (const block of Array.isArray(message.content) ? message.content.map(record) : []) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        put({
          type: 'tool.updated', turnId, itemId: claudeToolItemId(scope, block.tool_use_id), toolCallId: block.tool_use_id,
          status: block.is_error === true ? 'failed' : 'done',
          ...(block.content !== undefined ? { output: block.content as JsonValue } : {}),
        })
      }
      if (text !== '') put({ type: 'message.completed', turnId, itemId: claudeMessageItemId(scope, uuid ?? `history_${lineIndex}`), role: 'user', text })
      continue
    }
    const nativeId = typeof message.id === 'string' && message.id !== '' ? message.id : uuid ?? `history_${lineIndex}`
    const turnId = claudeHistoryTurnId(external, turnSeed ?? nativeId ?? `${external}:initial`)
    const blocks = Array.isArray(message.content) ? message.content.map(record) : []
    blocks.forEach((block, index) => {
      if ((block.type === 'thinking' || block.type === 'redacted_thinking') && typeof block.thinking === 'string' && block.thinking !== '') {
        put({ type: 'message.completed', turnId, itemId: claudeSystemItemId(scope, turnId, nativeId, index, String(block.type)), role: 'reasoning', text: block.thinking })
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        const name = typeof block.name === 'string' ? block.name : 'tool'
        put({
          type: 'tool.started', turnId, itemId: claudeToolItemId(scope, block.id), toolCallId: block.id,
          kind: claudeToolKind(name), title: name, status: 'running',
          ...(block.input !== undefined ? { input: block.input as JsonValue } : {}),
        })
      }
    })
    const text = textOf(message.content)
    if (text !== '') put({ type: 'message.completed', turnId, itemId: claudeMessageItemId(scope, nativeId), role: 'assistant', text })
  }
  // 工具结果合并进工具条目：started + updated → 一个条目的最终状态
  return mergeToolResults(items)
}

function mergeToolResults(items: HistoryItem[]): HistoryItem[] {
  const out: HistoryItem[] = []
  const tools = new Map<string, number>()
  for (const item of items) {
    if (item.type === 'tool.started') {
      tools.set(item.itemId, out.length)
      out.push(item)
    } else if (item.type === 'tool.updated' && tools.has(item.itemId)) {
      const at = tools.get(item.itemId)!
      const started = out[at] as Extract<HistoryItem, { type: 'tool.started' }>
      out[at] = { ...started, ...(item.status !== undefined ? { status: item.status } : {}) }
      out.push(item)
    } else {
      out.push(item)
    }
  }
  return out
}

/** 按窗口取一页：缺省最新 `limit` 条；`cursor` 是上一页开头的位置，向更早翻。 */

export { historyPage } from './page.js'
