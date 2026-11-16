import { ConversationError } from './errors.js'

/**
 * The per-session clock (06-protocols.md §3.1). `headSeq` is the last committed position; every item
 * upsert or delete takes the next value. `resetSeq` is a fence: a client cursor below it must refetch a
 * snapshot. Both are int64 on the wire; here they stay within Number.MAX_SAFE_INTEGER (the protocol limit).
 */
export interface SessionClock {
  readonly headSeq: number
  readonly resetSeq: number
}

export const INITIAL_CLOCK: SessionClock = Object.freeze({ headSeq: 0, resetSeq: 0 })

export const MAX_SEQ = Number.MAX_SAFE_INTEGER

function checkSeq(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ConversationError('invalid_argument', `${what} must be a non-negative safe integer`)
}

export function validateClock(clock: SessionClock): void {
  checkSeq(clock.headSeq, 'headSeq')
  checkSeq(clock.resetSeq, 'resetSeq')
  if (clock.resetSeq > clock.headSeq) throw new ConversationError('invalid_argument', 'resetSeq is beyond headSeq')
}

/** Allocates `count` consecutive sequence numbers; the clock never moves backwards. */
export function allocate(clock: SessionClock, count: number): { clock: SessionClock; first: number; last: number } {
  if (!Number.isSafeInteger(count) || count < 1) throw new ConversationError('invalid_argument', 'count must be a positive integer')
  const last = clock.headSeq + count
  if (last > MAX_SEQ) throw new ConversationError('clock_regression', 'session clock exhausted')
  return { clock: { headSeq: last, resetSeq: clock.resetSeq }, first: clock.headSeq + 1, last }
}

/**
 * Full replacement, history rewrite (Codex `history_reset`, rollback) or store rebuild: the fence takes the
 * next value itself, so cursors below it become invalid while a snapshot taken right after the reset
 * (`seq:resetSeq`) is already valid. The replacement content is then written with ordinary allocations.
 */
export function raiseResetFence(clock: SessionClock): SessionClock {
  const next = clock.headSeq + 1
  if (next > MAX_SEQ) throw new ConversationError('clock_regression', 'session clock exhausted')
  return { headSeq: next, resetSeq: next }
}

/**
 * Applies the Server's `seqFloor` from `LinkWelcome.seqFloors`. When the local head is not above the floor
 * (store deleted, reinstalled, restored from a backup) the clock jumps past it and raises the fence, so every
 * `seq:N` a client has seen stays below anything the device emits from now on. `restamp` tells the caller that
 * existing items must be rewritten with new sequence numbers (they would otherwise look older than the fence).
 */
export function applySeqFloor(clock: SessionClock, seqFloor: number): { clock: SessionClock; restamp: boolean } {
  checkSeq(seqFloor, 'seqFloor')
  if (clock.headSeq > seqFloor) return { clock, restamp: false }
  return { clock: { headSeq: seqFloor + 1, resetSeq: seqFloor + 1 }, restamp: true }
}

export type CatchUpDecision =
  | { readonly kind: 'incremental' }
  | { readonly kind: 'up_to_date' }
  | { readonly kind: 'snapshot_required'; readonly reason: 'before_reset' | 'ahead_of_device' }

/**
 * Whether a client that has applied everything up to `afterSeq` can catch up with incremental events.
 * A cursor below the fence missed a replacement; a cursor above the head comes from a previous store.
 */
export function catchUp(clock: SessionClock, afterSeq: number): CatchUpDecision {
  checkSeq(afterSeq, 'afterSeq')
  if (afterSeq > clock.headSeq) return { kind: 'snapshot_required', reason: 'ahead_of_device' }
  // `seq:N` means "applied everything up to N": a reset at resetSeq invalidates every N below it, the fence's
  // predecessor included, because that client still shows content the replacement may have dropped.
  if (afterSeq < clock.resetSeq) return { kind: 'snapshot_required', reason: 'before_reset' }
  if (afterSeq === clock.headSeq) return { kind: 'up_to_date' }
  return { kind: 'incremental' }
}

/** The client-facing cursor (`seq:N`), unchanged from v2 (06-protocols.md §3.2). */
export function eventCursor(seq: number): string {
  checkSeq(seq, 'seq')
  return `seq:${seq}`
}

export function parseEventCursor(cursor: string): number {
  const match = /^seq:(0|[1-9]\d*)$/.exec(cursor)
  if (!match) throw new ConversationError('invalid_argument', 'invalid event cursor')
  const value = Number(match[1])
  checkSeq(value, 'cursor')
  return value
}
