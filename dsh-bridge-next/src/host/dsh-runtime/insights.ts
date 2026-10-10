import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-todo'
import { record } from './types.js'

/**
 * Detailed AI-call insights for one session: cumulative token usage, context
 * occupancy, turn/step counters and decode speed, plus the goal, todo list
 * and direct sub-agent catalog when the owning DSH plugins are mounted.
 *
 * Every projection is read through `ctx.get('sessionProjections')`, so a DSH
 * deployment without the token meter / session-stats / goal / todo / subagent
 * units simply yields `undefined` for that key and the field is omitted.
 */

export interface InsightTokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface InsightContextPressure {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

export interface InsightSessionStats {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

export interface InsightGoal {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  blockedReason?: { code: string, message: string }
  maxGoalRounds: number
  roundsStarted: number
  createdAt: number
  updatedAt: number
}

export interface InsightTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface InsightSubagent {
  id: string
  createdAt: number
  mode: 'one-shot' | 'continuable' | 'unknown'
  label?: string
}

/** One Agent Teams member from the Lead session's `agentTeam` projection. */
export interface InsightTeamMember {
  id: string
  name: string
  role: 'lead' | 'teammate'
  phase: 'provisioning' | 'active' | 'failed'
  description?: string
  provider?: string
  context?: 'fresh' | 'fork'
  error?: string
}

/** Whole-session insights published in `session.state.updated` metadata. */
export interface SessionInsights {
  tokenUsage?: InsightTokenUsage
  contextPressure?: InsightContextPressure
  sessionStats?: InsightSessionStats
  goal?: InsightGoal | null
  todos?: InsightTodo[] | null
  subagentCatalog?: InsightSubagent[]
  teamMembers?: InsightTeamMember[]
}

/** Exact per-turn token accounting attached to `session.turnEnded`. */
export interface TurnUsage {
  uncachedInputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

// The insight projection keys are registered by optional DSH units
// (dsh-token-meter, dsh-session-stats, dsh-goal, dsh-tool-todo, dsh-subagent)
// that a deployment may not mount, and not all of them are installed at
// typecheck time. The registry keys are plain strings on the wire.
const INSIGHT_KEYS: readonly string[] = ['tokenUsage', 'contextPressure', 'sessionStats', 'goal', 'todos', 'subagentCatalog', 'agentTeam']

export class RuntimeInsights {
  constructor(private ctx: Context) {}

  /**
   * Read the current insights for one session. Live sessions are answered
   * from the projection registry directly; cold sessions replay their log
   * through the registry without activating the Agent.
   */
  async session(live: Session | undefined, id: SessionId, snapshot?: SessionLogSnapshot): Promise<SessionInsights> {
    const projections = this.ctx.get('sessionProjections')
    if (!projections) return {}
    try {
      const target = live ?? this.ctx.sessions.get(id)
      const projected = target
        ? projections.snapshot(target, INSIGHT_KEYS as readonly (keyof import('@deepseek-ai/dsh-session-projection/types').SessionProjectionMap)[])
        : (() => {
            const log = snapshot
            if (!log) return undefined
            return projections.restore({}, log.events, SessionLogOffset(0), log.session, log.inheritedEventCount).snapshot
          })()
      if (!projected) return {}
      const values = projected.values as Record<string, unknown>
      const result: SessionInsights = {}
      const tokenUsage = values.tokenUsage as InsightTokenUsage | undefined
      if (tokenUsage && typeof tokenUsage === 'object') result.tokenUsage = tokenUsage
      const pressure = values.contextPressure as InsightContextPressure | undefined
      if (pressure && typeof pressure === 'object') result.contextPressure = pressure
      const stats = values.sessionStats as InsightSessionStats | undefined
      if (stats && typeof stats === 'object') result.sessionStats = stats
      if ('goal' in values) result.goal = sanitizeGoal(values.goal)
      if ('todos' in values) result.todos = sanitizeTodos(values.todos)
      if ('subagentCatalog' in values) {
        const catalog = sanitizeSubagents(values.subagentCatalog)
        if (catalog) result.subagentCatalog = catalog
      }
      if ('agentTeam' in values) {
        const members = sanitizeTeamMembers(values.agentTeam)
        if (members) result.teamMembers = members
      }
      return result
    } catch {
      // Insights are best-effort: a session state read never fails on them.
      return {}
    }
  }

  /**
   * Whether an event may change any insight projection. Used by the sync
   * feed to schedule a state refresh even when the session status itself is
   * unchanged.
   */
  static affects(event: SessionEvent): boolean {
    return INSIGHT_EVENT_TYPES.has(event.type)
  }
}

/**
 * Exact token accounting for one finished turn, folded from the turn's
 * durable events. Mirrors the official `@deepseek-ai/dsh-token-meter`
 * `deriveTurnTokenUsage` accounting: every billed attempt must report its
 * usage for the aggregate to be provable, otherwise the turn's disclosure is
 * unavailable (undefined) rather than approximate. The bridge does not depend
 * on the token-meter package, so the fold is reimplemented against the
 * durable event vocabulary.
 */
export function deriveTurnUsage(_ctx: Context, events: readonly SessionEvent[]): TurnUsage | undefined {
  let uncachedInput = 0
  let output = 0
  let total = 0
  let cacheRead = 0
  let cacheWrite = 0
  let reasoning = 0
  let cacheReadComplete = true
  let cacheWriteComplete = true
  let reasoningComplete = true
  let billedAttempts = 0
  let inTurn = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      inTurn = true
      continue
    }
    if (event.type === 'turn/end') break
    if (!inTurn || event.type !== 'assistant/message') continue
    const data = record((event as { data?: unknown }).data)
    // Interrupted or empty messages carry no provider usage.
    const usage = record(data.usage)
    const input = numberOrUndefined(usage.inputTokens)
    const outputTokens = numberOrUndefined(usage.outputTokens)
    if (input === undefined && outputTokens === undefined) continue
    if (input === undefined || outputTokens === undefined) return undefined
    billedAttempts += 1
    uncachedInput += input
    output += outputTokens
    const totalTokens = numberOrUndefined(usage.totalTokens)
    if (totalTokens === undefined) return undefined
    total += totalTokens
    const read = numberOrUndefined(usage.cacheReadTokens)
    if (read === undefined) cacheReadComplete = false
    else cacheRead += read
    const write = numberOrUndefined(usage.cacheWriteTokens)
    if (write === undefined) cacheWriteComplete = false
    else cacheWrite += write
    const reason = numberOrUndefined(usage.reasoningTokens)
    if (reason === undefined) reasoningComplete = false
    else reasoning += reason
  }
  if (!billedAttempts) return undefined
  return {
    uncachedInputTokens: uncachedInput,
    outputTokens: output,
    totalTokens: total,
    ...(cacheReadComplete ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWriteComplete ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoningComplete ? { reasoningTokens: reasoning } : {}),
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Events that can move at least one insight projection. */
const INSIGHT_EVENT_TYPES = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'assistant/message', 'assistant/attempt',
  'tool/call', 'tool/result',
  'request/header', 'request/context',
  'goal/change', 'todo/write',
  'subagent/catalog', 'subagent/descriptor',
  'agent-preset/selected', 'model/selection',
  'compaction/start', 'compaction/end',
  'team/member', 'team/task', 'team/message/queued', 'team/message/delivered',
])

function sanitizeGoal(value: unknown): InsightGoal | null {
  if (value === null) return null
  const projection = record(value)
  const goal = record(projection.goal)
  if (typeof goal.id !== 'string' || typeof goal.objective !== 'string') return null
  const phase = goal.phase
  return {
    id: goal.id,
    revision: Number(goal.revision) || 0,
    objective: goal.objective,
    phase: phase === 'paused' || phase === 'blocked' || phase === 'complete' ? phase : 'active',
    ...(goal.blockedReason && typeof goal.blockedReason === 'object' ? { blockedReason: record(goal.blockedReason) as { code: string, message: string } } : {}),
    maxGoalRounds: Number(goal.maxGoalRounds) || 0,
    roundsStarted: Number(projection.roundsStarted) || 0,
    createdAt: Number(projection.createdAt) || 0,
    updatedAt: Number(projection.updatedAt) || 0,
  }
}

function sanitizeTodos(value: unknown): InsightTodo[] | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) return null
  return value.flatMap(item => {
    const todo = record(item)
    if (typeof todo.content !== 'string') return []
    const status = todo.status
    return [{
      content: todo.content,
      status: status === 'in_progress' || status === 'completed' ? status : 'pending',
    }]
  })
}

function sanitizeSubagents(value: unknown): InsightSubagent[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap(item => {
    const entry = record(item)
    if (typeof entry.id !== 'string') return []
    const mode = entry.mode
    return [{
      id: entry.id,
      createdAt: Number(entry.createdAt) || 0,
      mode: mode === 'one-shot' || mode === 'continuable' ? mode : 'unknown' as const,
      ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
    }]
  })
}

function sanitizeTeamMembers(value: unknown): InsightTeamMember[] | undefined {
  const projection = record(value)
  const members = projection.members
  if (!Array.isArray(members) || !members.length) return undefined
  return members.flatMap(item => {
    const entry = record(item)
    if (typeof entry.id !== 'string' || typeof entry.name !== 'string') return []
    const role = entry.role
    const phase = entry.phase
    return [{
      id: entry.id,
      name: entry.name,
      role: role === 'teammate' ? 'teammate' as const : 'lead' as const,
      phase: phase === 'provisioning' || phase === 'failed' ? phase : 'active' as const,
      ...(typeof entry.description === 'string' && entry.description ? { description: entry.description } : {}),
      ...(typeof entry.provider === 'string' && entry.provider ? { provider: entry.provider } : {}),
      ...(entry.context === 'fork' ? { context: 'fork' as const } : entry.context === 'fresh' ? { context: 'fresh' as const } : {}),
      ...(typeof entry.error === 'string' && entry.error ? { error: entry.error } : {}),
    }]
  })
}
