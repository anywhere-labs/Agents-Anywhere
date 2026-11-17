/**
 * The session goal as an explicit sub-aggregate (02-domain-model.md §5.3). Distilled from v2
 * `connector/connector/goals/service.py`: writes carry `expectedRevision` (CAS), every write has an
 * `operationId` and runs once, and an observed native goal either continues the current target or
 * replaces it. Runtime-specific reconciliation (Claude's elapsed-time carry, pause recovery against the
 * native peer) stays in the Runtime profile; this file holds the rules every Runtime shares.
 */
export type GoalAction = 'set' | 'edit' | 'pause' | 'resume' | 'clear'
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete' | 'failed' | 'cleared' | 'replaced'

export const GOAL_ACTIONS: readonly GoalAction[] = ['set', 'edit', 'pause', 'resume', 'clear']
export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set(['complete', 'failed', 'cleared', 'replaced'])

export class GoalConflict extends Error {
  public readonly code = 'goal_conflict'
  public constructor(message: string) {
    super(message)
    this.name = 'GoalConflict'
  }
}

export class GoalInvalid extends Error {
  public readonly code = 'invalid_argument'
  public constructor(message: string) {
    super(message)
    this.name = 'GoalInvalid'
  }
}

export interface Goal {
  readonly id: string
  readonly objective: string
  readonly status: GoalStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly endedAt?: string | null
  readonly iterations?: number | null
  readonly lastReason?: string | null
  readonly sourceTurnId?: string | null
  readonly timeUsedSeconds?: number | null
  readonly tokenBudget?: number | null
  readonly tokensUsed?: number | null
}

export interface GoalCapabilities {
  readonly supported: boolean
  readonly actions: readonly GoalAction[]
  readonly reason?: string | null
}

export interface GoalState {
  readonly sessionId: string
  readonly runtime: string
  readonly runtimeId: string | null
  readonly externalSessionId: string | null
  readonly revision: number
  readonly bindingGeneration: number
  readonly sourceEpoch: string
  readonly freshness: 'fresh' | 'stale' | 'unknown'
  readonly capabilities: GoalCapabilities
  readonly goal: Goal | null
  readonly lastOutcome: Goal | null
  readonly pendingOperationId: string | null
  /** Native identity of the current target, when the Runtime has one (Codex goal id). */
  readonly nativeIdentity: string | null
}

export function initialGoalState(input: { sessionId: string; runtime: string; runtimeId: string | null; sourceEpoch: string }): GoalState {
  return {
    sessionId: input.sessionId,
    runtime: input.runtime,
    runtimeId: input.runtimeId,
    externalSessionId: null,
    revision: 0,
    bindingGeneration: 0,
    sourceEpoch: input.sourceEpoch,
    freshness: 'unknown',
    capabilities: { supported: false, actions: [] },
    goal: null,
    lastOutcome: null,
    pendingOperationId: null,
    nativeIdentity: null,
  }
}

export interface GoalRequest {
  readonly action: GoalAction
  readonly expectedRevision: number
  readonly objective?: string | null
  readonly operationId: string
}

export const MAX_OBJECTIVE_CHARS = 4000

/** Validates a client write against the current state (CAS, allowed actions, pending operation). */
export function checkRequest(state: GoalState, request: GoalRequest): void {
  if (!request.operationId) throw new GoalInvalid('operationId is empty')
  if (!GOAL_ACTIONS.includes(request.action)) throw new GoalInvalid(`unknown goal action ${String(request.action)}`)
  if (!state.capabilities.supported || !state.capabilities.actions.includes(request.action)) {
    throw new GoalConflict(state.capabilities.reason ?? `goal action ${request.action} is not available now`)
  }
  if (request.expectedRevision !== state.revision) throw new GoalConflict('目标已被修改，请刷新后再试。')
  if (state.pendingOperationId !== null && state.pendingOperationId !== request.operationId) {
    throw new GoalConflict('上一次目标操作还没有结果。')
  }
  if (request.action === 'set' || request.action === 'edit') {
    const objective = request.objective?.trim() ?? ''
    if (!objective) throw new GoalInvalid('目标内容不能为空。')
    if (Array.from(objective).length > MAX_OBJECTIVE_CHARS) throw new GoalInvalid(`目标内容不能超过 ${MAX_OBJECTIVE_CHARS} 个字符。`)
  }
  if (request.action === 'edit' || request.action === 'pause' || request.action === 'clear') {
    if (state.goal === null) throw new GoalConflict('当前没有目标。')
  }
  if (request.action === 'resume' && state.goal?.status !== 'paused') throw new GoalConflict('目标没有暂停。')
}

function commit(state: GoalState, patch: Partial<GoalState>): GoalState {
  return { ...state, ...patch, revision: state.revision + 1 }
}

export function beginOperation(state: GoalState, operationId: string): GoalState {
  return commit(state, { pendingOperationId: operationId })
}

export function finishOperation(state: GoalState, operationId: string): GoalState {
  return state.pendingOperationId === operationId ? commit(state, { pendingOperationId: null }) : state
}

/** What the Runtime reports as the native goal (null: none; `empty`: the Runtime confirmed there is none). */
export interface GoalObservation {
  readonly goal: (Omit<Goal, 'id' | 'createdAt' | 'updatedAt'> & { readonly createdAt?: string; readonly updatedAt?: string; readonly nativeIdentity?: string | null }) | null
  readonly empty: boolean
  readonly actions?: readonly GoalAction[]
  readonly reason?: string | null
  /** Outcome to record when the goal disappears (`cleared` unless the Runtime knows better). */
  readonly outcome?: GoalStatus
}

/**
 * Merges an observation. A target with the same native identity (or, without one, the same objective)
 * continues the current goal; anything else replaces it, and the old one moves to `lastOutcome` as
 * `replaced`. A terminal native status moves the goal to `lastOutcome`.
 */
export function observe(state: GoalState, observation: GoalObservation | null, ids: { newId: () => string; now: string }): GoalState {
  if (observation === null) {
    return { ...state, freshness: 'unknown', capabilities: { supported: false, actions: [] } }
  }
  const capabilities: GoalCapabilities = {
    supported: true,
    actions: observation.actions ?? GOAL_ACTIONS,
    ...(observation.reason ? { reason: observation.reason } : {}),
  }
  const base: GoalState = { ...state, freshness: 'fresh', capabilities }
  const native = observation.goal
  if (native === null) {
    if (observation.empty && state.goal !== null && state.goal.status !== 'paused') {
      return commit(base, {
        goal: null,
        lastOutcome: { ...state.goal, status: observation.outcome ?? 'cleared', endedAt: ids.now, updatedAt: ids.now },
      })
    }
    return base
  }
  const { nativeIdentity, ...fields } = native
  const identity = nativeIdentity ?? null
  const old = state.goal
  const same = old !== null && (identity !== null ? identity === state.nativeIdentity : old.objective === fields.objective)
  let lastOutcome = state.lastOutcome
  let continued: Goal
  if (same && old !== null) {
    continued = { ...old, ...fields, createdAt: old.createdAt, updatedAt: fields.updatedAt ?? old.updatedAt }
  } else {
    if (old !== null) lastOutcome = { ...old, status: 'replaced', endedAt: ids.now, updatedAt: ids.now }
    const createdAt = fields.createdAt ?? ids.now
    continued = { ...fields, id: ids.newId(), createdAt, updatedAt: fields.updatedAt ?? createdAt }
  }
  let goal: Goal | null = continued
  if (TERMINAL_GOAL_STATUSES.has(continued.status)) {
    lastOutcome = { ...continued, endedAt: continued.endedAt ?? ids.now }
    goal = null
  }
  const nextIdentity = identity ?? (same ? state.nativeIdentity : null)
  if (JSON.stringify(goal) === JSON.stringify(state.goal) && JSON.stringify(lastOutcome) === JSON.stringify(state.lastOutcome) && nextIdentity === state.nativeIdentity) {
    return base
  }
  return commit(base, { goal, lastOutcome, nativeIdentity: nextIdentity })
}

/** The list-level summary the Server may store (no objective text). */
export function goalStateSummary(state: GoalState | null): 'none' | 'active' | 'paused' | 'completed' {
  const goal = state?.goal ?? null
  if (goal === null) return state?.lastOutcome?.status === 'complete' ? 'completed' : 'none'
  if (goal.status === 'paused') return 'paused'
  return 'active'
}

/** The client shape (`GoalState` in protocol 1.2). Controls are hidden from callers that may not write. */
export function goalWire(state: GoalState, allowControl: boolean): Record<string, unknown> {
  return structuredClone({
    sessionId: state.sessionId,
    runtime: state.runtime,
    runtimeId: state.runtimeId,
    externalSessionId: state.externalSessionId,
    revision: state.revision,
    bindingGeneration: state.bindingGeneration,
    sourceEpoch: state.sourceEpoch,
    sourceRevision: state.revision,
    freshness: state.freshness,
    capabilities: allowControl ? state.capabilities : { ...state.capabilities, actions: [] },
    goal: state.goal,
    lastOutcome: state.lastOutcome,
    pendingOperationId: state.pendingOperationId,
  })
}

/**
 * The goal of a session the Runtime has not reported on yet. `actions` are the goal actions the Runtime's
 * capabilities declare (null: no goal support). With support the state reads as `fresh` without a goal, so a
 * client may set the first one; the device observes the native goal before applying any action and answers a
 * conflict when the native side already had one.
 */
export function unobservedGoalState(
  input: { sessionId: string; runtime: string; runtimeId: string | null; externalSessionId: string | null },
  actions: readonly string[] | null,
): GoalState {
  const initial = { ...initialGoalState({ ...input, sourceEpoch: '' }), externalSessionId: input.externalSessionId }
  if (actions === null) return initial
  const declared = GOAL_ACTIONS.filter(action => actions.includes(action))
  return { ...initial, freshness: 'fresh', capabilities: { supported: true, actions: declared } }
}
