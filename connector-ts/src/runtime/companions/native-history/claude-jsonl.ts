// Read-only access to Claude native history: parses Claude Code's JSONL directly (`~/.claude/projects/<dir>/<session>.jsonl`).
//
// ACP `session/load` cannot be used to browse history: claude-agent-acp appends records to the JSONL when it loads a
// session (measured in S2). Item IDs follow the Claude identity rules existing timelines use:
// - turn ID: `claudeHistoryTurnId(session, uuid of the user message that opens the turn)`;
// - user message: `claudeMessageItemId(session, uuid)`; assistant message: `claudeMessageItemId(session, API message ID)`,
//   and one API message split across several lines is merged into one item; thinking block: `claudeSystemItemId`;
//   tool: `claudeToolItemId(session, tool_use id)`.

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { modelFailureReason } from '../../../domain/collab/review-execution.js'
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

/** Finds `<session>.jsonl` in the project directories. Session IDs allow only safe characters, so no path outside the directories can be built. */
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
      // not in this project
    }
  }
  return undefined
}

const record = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {})

/** Claude may finish ACP normally even when its native turn ends on a provider error. */
export async function claudeProviderFailure(nativeSessionId: string): Promise<'timeout' | 'failed' | undefined> {
  const file = await findClaudeTranscript(nativeSessionId)
  if (file === undefined) return undefined
  let failure: 'timeout' | 'failed' | undefined
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      let entry: Json
      try { entry = record(JSON.parse(line)) } catch { continue }
      if (entry.isSidechain === true) continue
      const message = record(entry.message)
      if (entry.type === 'user') {
        const content = message.content
        if (typeof content === 'string' || (Array.isArray(content) && content.some(block => record(block).type === 'text'))) failure = undefined
        continue
      }
      if (entry.type !== 'assistant') continue
      failure = undefined
      if (entry.isApiErrorMessage !== true && typeof entry.error !== 'string') continue
      const text = Array.isArray(message.content) ? message.content.map(part => record(part).text).filter(value => typeof value === 'string').join(' ') : ''
      failure = modelFailureReason(text)
    }
  } catch {
    return undefined
  }
  return failure
}

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

/** Projects one JSONL file into history items (oldest to newest). */
export async function readClaudeTranscript(file: string, scope: ClaudeSessionScope): Promise<HistoryItem[]> {
  const items: HistoryItem[] = []
  const position = new Map<string, number>()
  const put = (item: HistoryItem) => {
    // Only messages are merged (one API message written across several lines); a tool's start and result are two events and both are kept.
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
    // One API message written across several lines: concatenate the text (the live stream also joins in arrival order).
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
  // Tool results merge into the tool item: started + updated -> the final state of one item
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

/** Takes one page by window: by default the newest `limit` items; `cursor` is the start of the previous page, paging toward older items. */

export { historyPage } from './page.js'
