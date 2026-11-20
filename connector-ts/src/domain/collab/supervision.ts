import type { SessionAddress } from './address.js'
import type { Authority } from './authority.js'
import { CollabError } from './errors.js'
import { type TargetSignal, type Trigger, DEFAULT_TRIGGERS, isBusy, reasonsBetween } from './signals.js'

/**
 * Supervision (docs/agent-collaboration.md §5.2): "S1 watches S2". Kept on the supervisor's device; the Server only
 * keeps the edge (ids and state). Immutable value.
 *
 * Invariants:
 * 1. At most one active supervision per (supervisor, target) (enforced by the service against the store).
 * 2. No cycles (checked with `wouldCycle` before starting).
 * 3. At most one pending wake: new reasons merge into it; it is delivered only while the supervisor is not busy.
 * 4. Over the hourly wake budget the supervision pauses and a person is asked, nothing is dropped silently.
 * 5. The cursor only moves forward; a target reset above it is reported in the next digest.
 * 6. An Agent may create a supervision only of a session it created (checked by the grant).
 * 7. A person may pause, end or change it at any time.
 */
export interface PendingWake {
  readonly reasons: readonly Trigger[]
  readonly since: string
  readonly sinceMs: number
}

export interface SupervisionBudget {
  readonly coalesceMs: number
  readonly wakesPerHour: number
}

export const DEFAULT_BUDGET: SupervisionBudget = Object.freeze({ coalesceMs: 30_000, wakesPerHour: 20 })
export const DEFAULT_STALLED_MINUTES = 10

export interface Supervision {
  readonly supervisionId: string
  readonly supervisor: SessionAddress
  readonly target: SessionAddress
  readonly triggers: readonly Trigger[]
  readonly stalledMinutes: number
  readonly authority: Authority
  readonly budget: SupervisionBudget
  /** Target clock position already summarized into a digest. */
  readonly cursor: { readonly seq: number; readonly resetSeq: number }
  readonly lastSignal: TargetSignal | null
  /** When the target last made progress (its head moved or it changed status), for `stalled`. */
  readonly lastProgressMs: number | null
  readonly stalledReported: boolean
  readonly pendingWake: PendingWake | null
  /** Wake times (ms) within the last hour, oldest first. */
  readonly wakes: readonly number[]
  readonly state: 'active' | 'paused' | 'ended'
  readonly pausedReason: string | null
  readonly createdBy: 'human' | 'agent'
  readonly createdAt: string
  readonly updatedAt: string
}

export interface StartSupervisionInput {
  readonly supervisionId: string
  readonly supervisor: SessionAddress
  readonly target: SessionAddress
  readonly triggers?: readonly Trigger[]
  readonly stalledMinutes?: number
  readonly authority: Authority
  readonly budget?: Partial<SupervisionBudget>
  readonly cursor?: { readonly seq: number; readonly resetSeq: number }
  readonly createdBy: 'human' | 'agent'
  readonly at: string
}

export function startSupervision(input: StartSupervisionInput): Supervision {
  if (input.supervisor.sessionId === input.target.sessionId) throw new CollabError('agent_supervision_cycle', 'A session cannot supervise itself.')
  const stalled = input.stalledMinutes ?? DEFAULT_STALLED_MINUTES
  if (!(stalled > 0)) throw new CollabError('invalid_argument', 'stalledMinutes must be positive')
  return {
    supervisionId: input.supervisionId,
    supervisor: input.supervisor,
    target: input.target,
    triggers: input.triggers ?? DEFAULT_TRIGGERS,
    stalledMinutes: stalled,
    authority: input.authority,
    budget: { ...DEFAULT_BUDGET, ...(input.budget ?? {}) },
    cursor: input.cursor ?? { seq: 0, resetSeq: 0 },
    lastSignal: null,
    lastProgressMs: null,
    stalledReported: false,
    pendingWake: null,
    wakes: [],
    state: 'active',
    pausedReason: null,
    createdBy: input.createdBy,
    createdAt: input.at,
    updatedAt: input.at,
  }
}

function withReasons(supervision: Supervision, reasons: readonly Trigger[], at: string, nowMs: number): Supervision {
  const wanted = reasons.filter(reason => supervision.triggers.includes(reason))
  if (wanted.length === 0) return supervision
  const pending = supervision.pendingWake
  const merged = pending === null ? wanted : [...new Set([...pending.reasons, ...wanted])]
  return { ...supervision, pendingWake: { reasons: merged, since: pending?.since ?? at, sinceMs: pending?.sinceMs ?? nowMs } }
}

/** Takes in a target signal: remembers it and, when a trigger fired, merges the reason into the pending wake. */
export function observe(supervision: Supervision, signal: TargetSignal, nowMs: number): Supervision {
  if (supervision.state === 'ended') return supervision
  const previous = supervision.lastSignal
  // A signal older than the last one (out-of-order delivery) changes nothing.
  if (previous !== null && signal.headSeq < previous.headSeq && signal.resetSeq <= previous.resetSeq) return supervision
  const progressed = previous === null || signal.headSeq !== previous.headSeq || signal.status !== previous.status
  let next: Supervision = {
    ...supervision,
    lastSignal: signal,
    lastProgressMs: progressed ? nowMs : supervision.lastProgressMs,
    stalledReported: progressed ? false : supervision.stalledReported,
    updatedAt: signal.at,
  }
  if (supervision.state === 'active') next = withReasons(next, reasonsBetween(previous, signal), signal.at, nowMs)
  return next
}

/** `stalled`: the target is busy and its clock has not moved for `stalledMinutes`. Reported once per stall. */
export function checkStalled(supervision: Supervision, nowMs: number, at: string): Supervision {
  const signal = supervision.lastSignal
  if (supervision.state !== 'active' || signal === null || supervision.stalledReported || supervision.lastProgressMs === null) return supervision
  if (!isBusy(signal.status)) return supervision
  if (nowMs - supervision.lastProgressMs < supervision.stalledMinutes * 60_000) return supervision
  const next = withReasons(supervision, ['stalled'], at, nowMs)
  return { ...next, stalledReported: true }
}

/** Whether the pending wake may be delivered now: the coalescing window passed and the supervisor is not busy. */
export function readyToWake(supervision: Supervision, nowMs: number, supervisorBusy: boolean): boolean {
  if (supervision.state !== 'active' || supervision.pendingWake === null || supervisorBusy) return false
  return nowMs - supervision.pendingWake.sinceMs >= supervision.budget.coalesceMs
}

/**
 * The pending wake was delivered: clears it, moves the cursor and counts the wake. Over the hourly budget the
 * supervision pauses instead (`overBudget`), and the caller asks a person.
 */
export function recordWake(supervision: Supervision, cursor: { seq: number; resetSeq: number }, nowMs: number, at: string): { supervision: Supervision; overBudget: boolean } {
  const recent = [...supervision.wakes.filter(time => nowMs - time < 3_600_000), nowMs]
  const overBudget = recent.length > supervision.budget.wakesPerHour
  const seq = Math.max(supervision.cursor.seq, cursor.seq)
  const resetSeq = Math.max(supervision.cursor.resetSeq, cursor.resetSeq)
  const next: Supervision = { ...supervision, pendingWake: null, cursor: { seq, resetSeq }, wakes: recent, updatedAt: at }
  return overBudget ? { supervision: { ...next, state: 'paused', pausedReason: 'wake_budget' }, overBudget } : { supervision: next, overBudget }
}

/** Over budget before delivering: the wake is held, the supervision pauses. */
export function wouldExceedBudget(supervision: Supervision, nowMs: number): boolean {
  return supervision.wakes.filter(time => nowMs - time < 3_600_000).length >= supervision.budget.wakesPerHour
}

export function pause(supervision: Supervision, reason: string, at: string): Supervision {
  if (supervision.state !== 'active') return supervision
  return { ...supervision, state: 'paused', pausedReason: reason, updatedAt: at }
}

export function resume(supervision: Supervision, at: string): Supervision {
  if (supervision.state !== 'paused') return supervision
  return { ...supervision, state: 'active', pausedReason: null, wakes: [], updatedAt: at }
}

export function end(supervision: Supervision, at: string): Supervision {
  if (supervision.state === 'ended') return supervision
  return { ...supervision, state: 'ended', pendingWake: null, updatedAt: at }
}

export function update(supervision: Supervision, change: { triggers?: readonly Trigger[]; authority?: Authority; stalledMinutes?: number }, at: string): Supervision {
  return {
    ...supervision,
    ...(change.triggers !== undefined ? { triggers: change.triggers } : {}),
    ...(change.authority !== undefined ? { authority: change.authority } : {}),
    ...(change.stalledMinutes !== undefined && change.stalledMinutes > 0 ? { stalledMinutes: change.stalledMinutes } : {}),
    updatedAt: at,
  }
}
