// ported from effi-crew cloud/agentd/src/conv/mapping.ts @30f8334
//
// ACP `session/update` → 内部 RuntimeEvent。agentd 直接改写 Message parts；这里只翻译成事件，
// 投影成 TimelineItem 是 Conversation 的事。Timeline 条目 ID 由方言的 ItemIdentity 按 v2 规则给出。

import type {
  ConfigOption,
  RuntimeEvent,
  ToolContent,
  ToolKind,
  ToolLocation,
  ToolStatus,
} from '../../application/ports/runtime-session.js'
import type { JsonValue } from '../../domain/identity/index.js'
import { asRecord, type JsonRecord } from './client.js'
import { normalizeConfig } from './config.js'
import type { ItemIdentity } from './dialect.js'

/** 内容块的文本（agentd `contentText`）。 */
export function contentText(raw: unknown): string | undefined {
  const block = asRecord(raw)
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : undefined
    case 'resource_link':
      return `[${String(block.title ?? block.name ?? block.uri)}](${String(block.uri)})`
    case 'resource': {
      const resource = asRecord(block.resource)
      return typeof resource.text === 'string' ? resource.text : typeof resource.uri === 'string' ? `[${resource.uri}]` : undefined
    }
    case 'image':
      return '[image]'
    case 'audio':
      return '[audio]'
    default:
      return undefined
  }
}

const TOOL_KINDS = new Set<ToolKind>(['command', 'file_change', 'read', 'search', 'fetch', 'web_search', 'mcp', 'agent_call', 'think', 'other'])

/** ACP ToolKind（read / edit / delete / move / search / execute / think / fetch / switch_mode / other）→ AA。 */
export function toolKind(raw: unknown): ToolKind {
  switch (raw) {
    case 'execute':
      return 'command'
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_change'
    case 'read':
      return 'read'
    case 'search':
      return 'search'
    case 'fetch':
      return 'fetch'
    case 'think':
      return 'think'
    default:
      return typeof raw === 'string' && TOOL_KINDS.has(raw as ToolKind) ? (raw as ToolKind) : 'other'
  }
}

export function toolStatus(raw: unknown, fallback: ToolStatus): ToolStatus {
  switch (raw) {
    case 'pending':
      return 'pending'
    case 'in_progress':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    default:
      return fallback
  }
}

function toolContent(raw: unknown): ToolContent[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ToolContent[] = []
  for (const entry of raw.map(asRecord)) {
    if (entry.type === 'content') {
      const inner = asRecord(entry.content)
      if (inner.type === 'image' && typeof inner.mimeType === 'string') {
        out.push({ type: 'image', mimeType: inner.mimeType, ...(typeof inner.data === 'string' ? { data: inner.data } : {}), ...(typeof inner.uri === 'string' ? { uri: inner.uri } : {}) })
        continue
      }
      const text = contentText(inner)
      if (text !== undefined) out.push({ type: 'text', text })
    } else if (entry.type === 'diff' && typeof entry.path === 'string') {
      out.push({ type: 'diff', path: entry.path, newText: typeof entry.newText === 'string' ? entry.newText : '', ...(typeof entry.oldText === 'string' ? { oldText: entry.oldText } : {}) })
    } else if (entry.type === 'terminal' && typeof entry.terminalId === 'string') {
      out.push({ type: 'terminal', terminalId: entry.terminalId })
    }
  }
  return out
}

function locations(raw: unknown): ToolLocation[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.map(asRecord).filter(l => typeof l.path === 'string').map(l => ({ path: String(l.path), ...(typeof l.line === 'number' ? { line: l.line } : {}) }))
}

function planEntries(raw: unknown): Extract<RuntimeEvent, { type: 'plan.updated' }>['entries'] {
  if (!Array.isArray(raw)) return []
  return raw.map(asRecord).map(e => ({
    content: String(e.content ?? ''),
    status: e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'in_progress' : 'pending',
    ...(e.priority === 'high' || e.priority === 'medium' || e.priority === 'low' ? { priority: e.priority } : {}),
  }))
}

export interface TranslateContext {
  readonly identity: ItemIdentity
  readonly turnId?: string
  readonly replay?: boolean
  /** 当前回合里用户消息已由 AA 自己写入：回显不再落条目。 */
  readonly suppressUserEcho: boolean
  /** 当前配置（`current_mode_update` 要改写成 config.updated）。 */
  readonly config: readonly ConfigOption[]
  /** 承载旧 session modes 的配置项 ID（缺省 `mode`）。 */
  readonly modesOptionId?: string
}

/** 是否算「接纳证据」：回合开始后第一个助手、思考、工具或计划更新（v2 公共引擎的接纳判定）。 */
export function isAcceptanceEvidence(update: JsonRecord): boolean {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
    case 'plan':
    case 'plan_update':
      return true
    default:
      return false
  }
}

/** 是否是会产出内容的更新（回合外到达时说明 Agent 自己开了一轮）。 */
export function isContentUpdate(update: JsonRecord): boolean {
  if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
    const text = contentText(update.content)
    return text !== undefined && text !== ''
  }
  return update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update' || update.sessionUpdate === 'plan'
}

/** 通用翻译。返回的事件不含 turn.* 边界（由会话引擎负责）。 */
export function translateUpdate(update: JsonRecord, context: TranslateContext): RuntimeEvent[] {
  const base = {
    ...(context.turnId !== undefined ? { turnId: context.turnId } : {}),
    ...(context.replay ? { replay: true } : {}),
  }
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk': {
      if (update.sessionUpdate === 'user_message_chunk' && context.suppressUserEcho) return []
      const itemId = context.identity.itemFor(update)
      const text = contentText(update.content)
      if (itemId === null || text === undefined || text === '') return []
      const role = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant'
      return [{ ...base, type: 'message.delta', itemId, role, text }]
    }
    case 'tool_call': {
      const itemId = context.identity.itemFor(update)
      if (itemId === null) return []
      const content = toolContent(update.content)
      const locs = locations(update.locations)
      return [{
        ...base,
        type: 'tool.started',
        itemId,
        toolCallId: String(update.toolCallId),
        kind: toolKind(update.kind),
        title: typeof update.title === 'string' && update.title !== '' ? update.title : 'Tool call',
        status: toolStatus(update.status, 'pending'),
        ...(update.rawInput !== undefined ? { input: update.rawInput as JsonValue } : {}),
        ...(content ? { content } : {}),
        ...(locs ? { locations: locs } : {}),
      }]
    }
    case 'tool_call_update': {
      const itemId = context.identity.itemFor(update)
      if (itemId === null) return []
      const content = toolContent(update.content)
      const locs = locations(update.locations)
      return [{
        ...base,
        type: 'tool.updated',
        itemId,
        toolCallId: String(update.toolCallId),
        ...(typeof update.title === 'string' && update.title !== '' ? { title: update.title } : {}),
        ...(update.kind !== undefined && update.kind !== null ? { kind: toolKind(update.kind) } : {}),
        ...(update.status !== undefined && update.status !== null ? { status: toolStatus(update.status, 'running') } : {}),
        ...(update.rawInput !== undefined ? { input: update.rawInput as JsonValue } : {}),
        ...(update.rawOutput !== undefined ? { output: update.rawOutput as JsonValue } : {}),
        ...(content ? { content } : {}),
        ...(locs ? { locations: locs } : {}),
      }]
    }
    case 'plan':
      return [{ ...base, type: 'plan.updated', planId: 'checklist', entries: planEntries(update.entries) }]
    case 'plan_update': {
      const plan = asRecord(update.plan)
      if (plan.type === 'markdown' && typeof plan.content === 'string') {
        return [{
          ...base,
          type: 'plan.updated',
          planId: String(plan.planId ?? 'plan'),
          entries: [],
          document: { planId: String(plan.planId ?? 'plan'), markdown: plan.content, title: 'Plan', revision: 0, contentHash: '', contentState: 'ready', createdAt: null, sourceTurnId: context.turnId ?? null },
        }]
      }
      return [{ ...base, type: 'plan.updated', planId: String(plan.planId ?? 'checklist'), entries: planEntries(plan.entries) }]
    }
    case 'available_commands_update': {
      const commands = Array.isArray(update.availableCommands) ? update.availableCommands.map(asRecord) : []
      return [{
        ...base,
        type: 'commands.updated',
        commands: commands.filter(c => typeof c.name === 'string').map(c => ({
          name: String(c.name),
          ...(typeof c.description === 'string' ? { description: c.description } : {}),
          ...(typeof asRecord(c.input).hint === 'string' ? { inputHint: String(asRecord(c.input).hint) } : {}),
        })),
      }]
    }
    case 'config_option_update': {
      const { options } = normalizeConfig({ configOptions: update.configOptions })
      return [{ ...base, type: 'config.updated', options }]
    }
    case 'current_mode_update': {
      const mode = typeof update.currentModeId === 'string' ? update.currentModeId : undefined
      if (mode === undefined) return []
      const target = context.modesOptionId ?? 'mode'
      const options = context.config.map(o => (o.id === target ? { ...o, currentValue: mode } : o))
      return [{ ...base, type: 'config.updated', options }]
    }
    case 'session_info_update':
      return [{
        ...base,
        type: 'session.info',
        ...(typeof update.title === 'string' ? { title: update.title } : {}),
        ...(typeof update.updatedAt === 'string' ? { updatedAt: update.updatedAt } : {}),
      }]
    case 'usage_update':
      return [{
        ...base,
        type: 'usage.updated',
        ...(typeof update.used === 'number' ? { usedTokens: update.used } : {}),
        ...(typeof update.size === 'number' ? { contextWindow: update.size } : {}),
        ...(asRecord(update.cost).amount !== undefined ? { cost: { amount: Number(asRecord(update.cost).amount), currency: String(asRecord(update.cost).currency ?? 'USD') } } : {}),
      }]
    case 'compaction_update': {
      const itemId = `compact:${context.turnId ?? 'session'}:${String(update.compactionId ?? update.id ?? '')}`
      return [{ ...base, type: 'notice', itemId, level: 'info', kind: 'compact', text: 'Context compacted' }]
    }
    default:
      return []
  }
}
