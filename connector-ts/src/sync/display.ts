import type { DisplayFields, SummaryFacts } from '../domain/conversation/index.js'

/**
 * The display envelope (02-domain-model.md §5.4): fields only people read (title, preview, working directory).
 * Plain in normal mode; sealed with the directory key in E2EE mode. The Server stores it and never reads it.
 */
export interface DisplayEnvelope {
  mode: 'plain' | 'sealed'
  keyId: string | null
  payload: Record<string, unknown> | string
}

/** Seals display fields for the outbox. The E2EE implementation lives with Device Trust (F). */
export interface DisplaySealer {
  seal(fields: DisplayFields): DisplayEnvelope
}

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
