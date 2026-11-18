/**
 * A supervised session's directory-level facts, as the Server forwards them (`collab.signal`) or the local change
 * feed reports them. Scheduling fields only: no content, so they are plaintext in both modes.
 */
export type TargetStatus = 'idle' | 'pending' | 'running' | 'waiting' | 'waiting_approval' | 'blocked' | 'stopping' | 'error' | 'unknown'

export interface TargetSignal {
  readonly status: TargetStatus
  readonly headSeq: number
  readonly resetSeq: number
  readonly latestTurnEndSeq: number | null
  readonly planState: 'none' | 'planning' | 'awaiting_review'
  readonly goalState: 'none' | 'active' | 'paused' | 'completed'
  readonly deviceOnline: boolean
  readonly at: string
}

export type Trigger = 'turn_end' | 'turn_failed' | 'notice_opened' | 'plan_proposed' | 'goal_changed' | 'stalled'

export const ALL_TRIGGERS: readonly Trigger[] = ['turn_end', 'turn_failed', 'notice_opened', 'plan_proposed', 'goal_changed', 'stalled']

export const DEFAULT_TRIGGERS: readonly Trigger[] = ['turn_end', 'turn_failed', 'notice_opened', 'plan_proposed', 'stalled']

const BUSY: ReadonlySet<TargetStatus> = new Set(['pending', 'running', 'stopping'])

export function isBusy(status: TargetStatus): boolean {
  return BUSY.has(status)
}

/** What happened between two signals of the same target, in a stable order. The first signal ever is a baseline. */
export function reasonsBetween(previous: TargetSignal | null, next: TargetSignal): Trigger[] {
  if (previous === null) return []
  const reasons: Trigger[] = []
  const turnEnded = (next.latestTurnEndSeq ?? 0) > (previous.latestTurnEndSeq ?? 0)
  const becameError = next.status === 'error' && previous.status !== 'error'
  if (turnEnded) reasons.push(next.status === 'error' ? 'turn_failed' : 'turn_end')
  else if (becameError) reasons.push('turn_failed')
  if (next.status === 'waiting_approval' && previous.status !== 'waiting_approval') reasons.push('notice_opened')
  if (next.planState === 'awaiting_review' && previous.planState !== 'awaiting_review') reasons.push('plan_proposed')
  if (next.goalState !== previous.goalState) reasons.push('goal_changed')
  return reasons
}

export function parseTriggers(value: unknown, fallback: readonly Trigger[] = DEFAULT_TRIGGERS): Trigger[] {
  if (!Array.isArray(value)) return [...fallback]
  const known = new Set<string>(ALL_TRIGGERS)
  const out = value.filter((item): item is Trigger => typeof item === 'string' && known.has(item))
  return [...new Set(out)]
}
