import type { SessionClock } from './clock.js'
import type { TimelineItem } from './timeline.js'
import type { ActiveTurn, SessionStatus } from './turn.js'

export type SourceAvailability = 'available' | 'archived' | 'deleted' | 'missing' | 'unknown'
export type PlanStateSummary = 'none' | 'planning' | 'awaiting_review'
export type GoalStateSummary = 'none' | 'active' | 'paused' | 'completed'

/**
 * Device-side facts of one session (the Conversation aggregate root's header). Content lives in the
 * timeline; platform metadata the user owns (pin, archive, title override, takeover) lives on the Server
 * and reaches the device only with commands (02-domain-model.md §4).
 */
export interface Session {
  readonly sessionId: string
  readonly runtimeType: string
  readonly runtimeId: string
  /** The native session (Codex threadId, Claude JSONL id, DSH id); null until the Runtime created it. */
  readonly externalSessionId: string | null
  readonly cwd: string | null
  /**
   * The Server project a client asked to file this session under when it created it through a secure channel
   * (encrypted mode, where the Server cannot see `cwd`). Null for sessions created through the Server or discovered.
   */
  readonly projectId?: string | null
  /** Title the Runtime reported (the user's override is a Server field). */
  readonly nativeTitle: string | null
  readonly status: SessionStatus
  readonly sourceAvailability: SourceAvailability
  readonly clock: SessionClock
  readonly activeTurn: ActiveTurn | null
  /** `headSeq` when the last turn ended; drives unread (`latestTurnEndSeq > readSeq`). */
  readonly latestTurnEndSeq: number | null
  readonly planState: PlanStateSummary
  readonly goalState: GoalStateSummary
  /** Last value the Server sent with a command; dispatch from the queue needs it. */
  readonly takeover: boolean
  readonly archived: boolean
  readonly createdAt: string
  readonly lastActivityAt: string
}

export interface LatestItemFacts {
  id: string
  type: string
  role: string | null
  status: string | null
  time: string | null
}

/** Display fields: shown to people only; sealed with the directory key in E2EE mode. */
export interface DisplayFields {
  title: string | null
  preview: string | null
  cwd: string | null
}

/**
 * What `session.summary` carries, without the display envelope (sealing is the outbound adapter's job).
 * No message text leaves the device here except inside `display`.
 */
export interface SummaryFacts {
  sessionId: string
  runtimeType: string
  runtimeId: string
  externalSessionId: string | null
  status: SessionStatus
  sortAt: string
  lastActivityAt: string
  latestItem: LatestItemFacts | null
  latestTurnEndSeq: number | null
  sourceAvailability: SourceAvailability
  headSeq: number
  resetSeq: number
  planState: PlanStateSummary
  goalState: GoalStateSummary
  /** Only for sessions a client created through a channel (`Session.projectId`); plain, it is not display text. */
  projectId?: string
  display: DisplayFields
}

const PREVIEW_CHARS = 200

/** A short plain-text preview of the latest message, for the session list. */
export function previewOf(item: TimelineItem | null): string | null {
  if (item === null || item.type !== 'message') return null
  const text = item.content.text
  if (typeof text !== 'string') return null
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (!flat) return null
  const chars = Array.from(flat)
  return chars.length <= PREVIEW_CHARS ? flat : `${chars.slice(0, PREVIEW_CHARS - 1).join('')}…`
}

export function summarize(session: Session, latestItem: TimelineItem | null): SummaryFacts {
  return {
    sessionId: session.sessionId,
    runtimeType: session.runtimeType,
    runtimeId: session.runtimeId,
    externalSessionId: session.externalSessionId,
    status: session.status,
    sortAt: session.lastActivityAt,
    lastActivityAt: session.lastActivityAt,
    latestItem: latestItem === null
      ? null
      : { id: latestItem.id, type: latestItem.type, role: latestItem.role, status: latestItem.status, time: latestItem.updatedAt },
    latestTurnEndSeq: session.latestTurnEndSeq,
    sourceAvailability: session.sourceAvailability,
    headSeq: session.clock.headSeq,
    resetSeq: session.clock.resetSeq,
    planState: session.planState,
    goalState: session.goalState,
    ...(typeof session.projectId === 'string' ? { projectId: session.projectId } : {}),
    display: { title: session.nativeTitle, preview: previewOf(latestItem), cwd: session.cwd },
  }
}

/**
 * Whether a change is worth a `session.summary` in the outbox. Item churn inside a running turn is not;
 * turn boundaries, status, title, plan/goal state and availability are (03-architecture.md §3.3).
 */
export function summaryChanged(before: SummaryFacts | null, after: SummaryFacts): boolean {
  if (before === null) return true
  return before.status !== after.status
    || before.latestTurnEndSeq !== after.latestTurnEndSeq
    || before.sourceAvailability !== after.sourceAvailability
    || before.planState !== after.planState
    || before.goalState !== after.goalState
    || before.resetSeq !== after.resetSeq
    || before.externalSessionId !== after.externalSessionId
    || before.display.title !== after.display.title
    || before.display.cwd !== after.display.cwd
    || (after.status !== 'running' && before.latestItem?.id !== after.latestItem?.id)
}

/**
 * The v2 `SessionRuntimeState` of a session (`GET runtime/state`, `state` of a selection update). `selections`
 * is what the device knows: the Runtime's report or the values just applied; absent when it knows none.
 */
export function runtimeStateWire(session: Session, selections: Readonly<Record<string, string>> | null): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    runtime: session.runtimeType,
    runtimeId: session.runtimeId,
    externalSessionId: session.externalSessionId,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.lastActivityAt,
    updatedSeq: session.clock.headSeq,
    metadata: { activeTurnId: session.activeTurn?.turnId ?? null },
    ...(selections !== null ? { selections: { ...selections } } : {}),
  }
}
