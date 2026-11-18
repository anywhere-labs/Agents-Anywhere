import type { SessionAddress } from './address.js'
import type { AgentVerb } from './grant.js'

/**
 * AgentAction (§5.3): one state-changing tool call, append-only. `actionId` is also the downstream command id /
 * clientMessageId, so a replay returns the first result. An unknown outcome is reported as such and never retried.
 */
export type ActionOutcome = 'pending' | 'accepted' | 'rejected' | 'unknown'

export interface AgentAction {
  readonly actionId: string
  readonly grantId: string
  readonly supervisor: SessionAddress
  readonly target: SessionAddress | null
  readonly verb: AgentVerb
  readonly inputDigest: string
  readonly outcome: ActionOutcome
  readonly errorCode: string | null
  readonly at: string
  readonly settledAt: string | null
}

export function settleAction(action: AgentAction, outcome: Exclude<ActionOutcome, 'pending'>, errorCode: string | null, at: string): AgentAction {
  if (action.outcome !== 'pending') return action
  return { ...action, outcome, errorCode, settledAt: at }
}
