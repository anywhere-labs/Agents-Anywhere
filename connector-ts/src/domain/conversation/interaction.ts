import { ConversationError } from './errors.js'

/**
 * Something that needs a person (protocol "notice"): an approval, a form, an execution-error card
 * offering "continue". Persisted, so after a Connector restart an open approval is shown as expired
 * instead of silently vanishing (02-domain-model.md §7 item 3).
 */
export type InteractionKind = 'approval' | 'input_request' | 'execution_error' | 'confirmation' | 'unknown'
export type InteractionState = 'open' | 'responding' | 'resolved' | 'expired'

export interface Interaction {
  readonly sessionId: string
  readonly noticeId: string
  readonly kind: InteractionKind
  readonly state: InteractionState
  /** Blocking interactions hold the turn (approvals, forms); they close when the turn or the Runtime ends. */
  readonly blocking: boolean
  /** The client-shaped notice (`NoticeIn`) as the Runtime adapter produced it. */
  readonly payload: Readonly<Record<string, unknown>>
  /** Id of the response that won, for idempotent replays of the same answer. */
  readonly responseId: string | null
  readonly resolution: string | null
  readonly openedAt: string
  readonly resolvedAt: string | null
}

export function open(input: { sessionId: string; noticeId: string; kind: InteractionKind; blocking: boolean; payload: Readonly<Record<string, unknown>>; at: string }): Interaction {
  if (!input.noticeId) throw new ConversationError('invalid_argument', 'noticeId is empty')
  return {
    sessionId: input.sessionId,
    noticeId: input.noticeId,
    kind: input.kind,
    state: 'open',
    blocking: input.blocking,
    payload: input.payload,
    responseId: null,
    resolution: null,
    openedAt: input.at,
    resolvedAt: null,
  }
}

export type RespondDecision =
  | { readonly kind: 'accepted'; readonly interaction: Interaction }
  /** The same response again: answer as before, do not forward twice. */
  | { readonly kind: 'duplicate'; readonly interaction: Interaction }

/** Invariant 6: an interaction takes the first valid response; later ones get `interaction_conflict`. */
export function respond(interaction: Interaction | undefined, responseId: string): RespondDecision {
  if (interaction === undefined) throw new ConversationError('interaction_not_found', 'interaction not found')
  if (!responseId) throw new ConversationError('invalid_argument', 'responseId is empty')
  if (interaction.responseId === responseId) return { kind: 'duplicate', interaction }
  if (interaction.state !== 'open') {
    throw new ConversationError('interaction_conflict', `interaction ${interaction.noticeId} is already ${interaction.state}`)
  }
  return { kind: 'accepted', interaction: { ...interaction, state: 'responding', responseId } }
}

/** The Runtime confirmed the outcome (or another surface, such as the Codex App, answered first). */
export function resolve(interaction: Interaction, resolution: string, at: string): Interaction {
  if (interaction.state === 'resolved' || interaction.state === 'expired') return interaction
  return { ...interaction, state: 'resolved', resolution, resolvedAt: at }
}

/** Forwarding the response failed for certain: the interaction is open again for another answer. */
export function reopen(interaction: Interaction): Interaction {
  if (interaction.state !== 'responding') return interaction
  return { ...interaction, state: 'open', responseId: null }
}

/** Turn ended, Runtime restarted, or the request was withdrawn: close with a reason clients can show. */
export function expire(interaction: Interaction, reason: string, at: string): Interaction {
  if (interaction.state === 'resolved' || interaction.state === 'expired') return interaction
  return { ...interaction, state: 'expired', resolution: reason, resolvedAt: at }
}

export function isActive(interaction: Interaction): boolean {
  return interaction.state === 'open' || interaction.state === 'responding'
}

/** Which interactions a turn end or a Runtime restart closes: every active blocking one. */
export function closedByTurnEnd(interactions: readonly Interaction[]): Interaction[] {
  return interactions.filter(interaction => interaction.blocking && isActive(interaction))
}
