import type { DisplaySealer } from '../application/ports/index.js'
import type { SummaryFacts } from '../domain/conversation/index.js'

export type { DisplayEnvelope, DisplaySealer } from '../application/ports/index.js'

export const plainSealer: DisplaySealer = {
  seal(fields) {
    return { mode: 'plain', keyId: null, payload: { ...fields } }
  },
}

/** `SessionSummary` on the wire (device-meshcall 1.0): facts plus the envelope, never message text. */
export function wireSummary(facts: SummaryFacts, sealer: DisplaySealer): Record<string, unknown> {
  return {
    sessionId: facts.sessionId,
    runtimeType: facts.runtimeType,
    runtimeId: facts.runtimeId,
    externalSessionId: facts.externalSessionId,
    status: facts.status,
    sortAt: facts.sortAt,
    lastActivityAt: facts.lastActivityAt,
    latestItem: facts.latestItem,
    latestTurnEndSeq: facts.latestTurnEndSeq,
    sourceAvailability: facts.sourceAvailability,
    headSeq: facts.headSeq,
    resetSeq: facts.resetSeq,
    planState: facts.planState,
    goalState: facts.goalState,
    displayDevice: sealer.seal(facts.display),
  }
}
