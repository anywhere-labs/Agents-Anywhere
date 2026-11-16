import { ConversationError } from './errors.js'

/**
 * A user message on its way from a client to the Runtime (02-domain-model.md §5.1, `clientMessageId`).
 *
 * - `accepted`: written to the local store; the device has promised to handle it (this is what
 *   `CommandAck.outcome = accepted` means: "落盘才确认").
 * - `queued`: waiting in the session queue (`Delivery(queued)`).
 * - `sending`: handed to the Runtime, waiting for acceptance evidence.
 * - `started`: the Runtime took it (a turn started or the steer landed).
 * - `rejected`: certainly had no effect.
 * - `unknown`: handed over but the outcome cannot be established. Never resent automatically.
 */
export type DeliveryState = 'accepted' | 'queued' | 'sending' | 'started' | 'rejected' | 'unknown'

export const TERMINAL_DELIVERY_STATES: ReadonlySet<DeliveryState> = new Set(['started', 'rejected', 'unknown'])

export interface Delivery {
  readonly sessionId: string
  readonly clientMessageId: string
  readonly state: DeliveryState
  /** Digest of what the client sent; a different digest under the same id is a conflict, not a retry. */
  readonly inputDigest: string
  /** The Runtime's id for the message or turn, once known. */
  readonly nativeRef: string | null
  readonly errorCode: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

const TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  accepted: ['queued', 'sending', 'rejected'],
  queued: ['sending', 'rejected'],
  sending: ['started', 'rejected', 'unknown'],
  started: [],
  // Only an explicit user retry (queue `retry`) puts a settled delivery back into the queue.
  rejected: [],
  unknown: [],
}

export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function transition(delivery: Delivery, to: DeliveryState, at: string, details: { nativeRef?: string | null; errorCode?: string | null } = {}): Delivery {
  if (!canTransition(delivery.state, to)) {
    throw new ConversationError('invalid_transition', `delivery ${delivery.clientMessageId} cannot go from ${delivery.state} to ${to}`)
  }
  return {
    ...delivery,
    state: to,
    nativeRef: details.nativeRef !== undefined ? details.nativeRef : delivery.nativeRef,
    errorCode: details.errorCode !== undefined ? details.errorCode : to === 'started' ? null : delivery.errorCode,
    updatedAt: at,
  }
}

/** A user retry of a failed or uncertain message: back into the queue under the same `clientMessageId`. */
export function requeueForRetry(delivery: Delivery, at: string): Delivery {
  if (delivery.state !== 'rejected' && delivery.state !== 'unknown') {
    throw new ConversationError('invalid_transition', `delivery ${delivery.clientMessageId} is ${delivery.state}, not retryable`)
  }
  return { ...delivery, state: 'queued', errorCode: null, updatedAt: at }
}

export type ReceiveDecision =
  | { readonly kind: 'new'; readonly delivery: Delivery }
  /** The same message again (client or Server retry): report the recorded state, do nothing else. */
  | { readonly kind: 'duplicate'; readonly delivery: Delivery }

/** Idempotent receipt by `clientMessageId` (invariant 5: at most one user message and one turn per id). */
export function receive(existing: Delivery | undefined, input: { sessionId: string; clientMessageId: string; inputDigest: string; at: string; queued: boolean }): ReceiveDecision {
  if (!input.clientMessageId) throw new ConversationError('invalid_argument', 'clientMessageId is empty')
  if (existing !== undefined) {
    if (existing.inputDigest !== input.inputDigest) {
      throw new ConversationError('delivery_conflict', `clientMessageId ${input.clientMessageId} was already used for a different message`)
    }
    return { kind: 'duplicate', delivery: existing }
  }
  return {
    kind: 'new',
    delivery: {
      sessionId: input.sessionId,
      clientMessageId: input.clientMessageId,
      state: input.queued ? 'queued' : 'accepted',
      inputDigest: input.inputDigest,
      nativeRef: null,
      errorCode: null,
      createdAt: input.at,
      updatedAt: input.at,
    },
  }
}

/**
 * After a Connector crash a delivery left in `sending` has an unknown fate unless the Runtime left
 * evidence (a user message carrying the same `clientMessageId`, a started turn).
 */
export function recoverAfterRestart(delivery: Delivery, accepted: boolean, at: string): Delivery {
  if (delivery.state !== 'sending' && delivery.state !== 'accepted') return delivery
  if (delivery.state === 'accepted') return delivery
  return accepted ? transition(delivery, 'started', at) : transition(delivery, 'unknown', at, { errorCode: 'delivery_outcome_unknown' })
}
