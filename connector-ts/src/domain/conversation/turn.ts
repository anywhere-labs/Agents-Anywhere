import { ConversationError } from './errors.js'
import { BUSY_STATUSES } from './queue.js'

/**
 * Session status as clients see it (`SessionSummary.status`). `unknown` only appears before the Runtime
 * reported anything.
 */
export type SessionStatus = 'idle' | 'pending' | 'running' | 'waiting' | 'waiting_approval' | 'blocked' | 'stopping' | 'error' | 'unknown'

export type QueueMode = 'auto' | 'interrupt' | 'never'

export type AdmissionDecision =
  /** Start a turn now. */
  | { readonly kind: 'dispatch' }
  /** Put it in the queue; `interrupt` asks the running turn to stop so it goes next. */
  | { readonly kind: 'enqueue'; readonly interrupt: boolean }
  /**
   * Refuse. `legacy` keeps the plain-text `session is <status>` error for clients that did not send `queue`;
   * otherwise the structured `session_busy`.
   */
  | { readonly kind: 'reject'; readonly code: 'session_busy'; readonly legacy: boolean; readonly status: SessionStatus }

/**
 * Invariant 4 (one active turn) applied to a new message, decided by the `queue` field. A queue
 * that already holds messages keeps order even when the session happens to be idle.
 */
export function admitMessage(input: { status: SessionStatus; queueLength: number; queue: QueueMode | null; queueAvailable: boolean }): AdmissionDecision {
  const busy = BUSY_STATUSES.has(input.status)
  if (!busy && input.queueLength === 0) return { kind: 'dispatch' }
  if (input.queue === null) return { kind: 'reject', code: 'session_busy', legacy: true, status: input.status }
  if (input.queue === 'never' || !input.queueAvailable) return { kind: 'reject', code: 'session_busy', legacy: false, status: input.status }
  return { kind: 'enqueue', interrupt: input.queue === 'interrupt' }
}

/** Steering goes into the running turn and bypasses the queue (allowed while `running` or `waiting_approval`). */
export function admitSteer(input: { status: SessionStatus; steerSupported: boolean }): void {
  if (!input.steerSupported) throw new ConversationError('invalid_transition', 'this Runtime cannot steer a running turn')
  if (input.status !== 'running' && input.status !== 'waiting_approval') {
    throw new ConversationError('session_busy', `cannot steer while the session is ${input.status}`)
  }
}

/** The turn currently holding the session (invariant 4). */
export interface ActiveTurn {
  readonly turnId: string
  /** The message that started it; null for an autonomous turn (Claude scheduled wake-up). */
  readonly clientMessageId: string | null
  readonly startedAt: string
}

export type TurnOutcome = 'completed' | 'interrupted' | 'failed'

export function startTurn(current: ActiveTurn | null, next: ActiveTurn): ActiveTurn {
  if (current !== null && current.turnId !== next.turnId) {
    throw new ConversationError('session_busy', `turn ${current.turnId} is still active`)
  }
  return current ?? next
}

/** The status a session settles in after a turn ends; an error pauses the queue (see queue.onTurnEnded). */
export function statusAfterTurn(outcome: TurnOutcome): { status: SessionStatus; queueOutcome: 'idle' | 'error' } {
  return outcome === 'failed' ? { status: 'error', queueOutcome: 'error' } : { status: 'idle', queueOutcome: 'idle' }
}
