import type { ConversationStore } from '../application/ports/index.js'
import { PAGE_BUDGET, SNAPSHOT_LIMIT, eventCursor, queue as queueRules, runtimeStateWire, toProtocolItem, type Interaction, type Session } from '../domain/conversation/index.js'
import { GOAL_ACTIONS, goalWire, unobservedGoalState } from '../domain/goals/index.js'
import { initialPlanning, planningCapabilities, planningWire, type PlanDocument } from '../domain/planning/index.js'
import type { ChangesSinceResponse } from '../generated/device-meshcall/v1_0/changes-since-response.js'
import type { CommandStatusResponse } from '../generated/device-meshcall/v1_0/command-status-response.js'
import type { StoreReadResponse } from '../generated/device-meshcall/v1_0/store-read-response.js'
import { timelineEvents } from './client-shape.js'

/** Live facts only the Runtime layer knows (capabilities, catalogs); null when the session is not open. */
export interface RuntimeFacts {
  sessionCapabilities(sessionId: string): Promise<Record<string, unknown> | null>
  catalogs(sessionId: string): Promise<Record<string, unknown> | null>
  /**
   * `state.selections` of a session that is not open (the Runtime's own report, e.g. an unopened Codex thread's
   * permission); null when there is none. An open session's selections travel with its configuration events.
   */
  selections?(sessionId: string): Promise<Record<string, string> | null>
}

/** Native history projected on demand (application `NativeHistory`); absent for Runtimes without native records. */
export interface HistoryBackfill {
  ensureLatest(sessionId: string): Promise<void>
  ensureBefore(sessionId: string, beforeOrderSeq: number | null, limit: number): Promise<boolean>
  /** Whether the native record has items older than what is stored. */
  hasOlder(sessionId: string): Promise<boolean>
}

/** Workspace preparation and the creation that consumed it (application `PreparationService`). */
export interface WorkflowReads {
  view(preparationId: string): Promise<Record<string, unknown>>
  creationView(createOperationId: string): Promise<Record<string, unknown>>
}

const NO_FACTS: RuntimeFacts = {
  sessionCapabilities: async () => null,
  catalogs: async () => null,
}

export class SessionNotFound extends Error {
  public readonly code = 'session_not_found'
  public constructor(sessionId: string) {
    super(`session ${sessionId} is not on this device`)
    this.name = 'SessionNotFound'
  }
}

/**
 * The device's read side (06-protocols.md §4): every answer is already client-shaped, bounded by count and
 * bytes, and safe to retry. The Server passes bodies through untouched.
 */
export class DeviceReaders {
  public constructor(
    private readonly store: ConversationStore,
    private readonly now: () => string,
    private readonly facts: RuntimeFacts = NO_FACTS,
    private readonly history: HistoryBackfill | null = null,
    private readonly workflows: WorkflowReads | null = null,
  ) {}

  private async session(sessionId: string): Promise<Session> {
    const session = await this.store.sessions.get(sessionId)
    if (session === null) throw new SessionNotFound(sessionId)
    return session
  }

  /** `client.snapshot`: the device part of the v1.2 snapshot body (the Server adds the directory fields). */
  public async snapshot(request: { sessionId: string; limit?: number; byteBudget?: number }): Promise<Record<string, unknown>> {
    await this.session(request.sessionId)
    await this.history?.ensureLatest(request.sessionId)
    const session = await this.session(request.sessionId)
    const page = await this.store.timeline.read(request.sessionId, 'latest', null, request.limit ?? SNAPSHOT_LIMIT, request.byteBudget ?? PAGE_BUDGET)
    const [interactions, queue, planning, goal, capabilities, catalogs, selections] = await Promise.all([
      this.store.interactions.list(request.sessionId, true),
      this.store.queues.get(request.sessionId),
      this.store.planning.load(request.sessionId),
      this.store.goals.load(request.sessionId),
      this.facts.sessionCapabilities(request.sessionId),
      this.facts.catalogs(request.sessionId),
      this.selections(request.sessionId),
    ])
    return {
      historySource: 'live',
      deviceOffline: false,
      eventCursor: eventCursor(page.headSeq),
      timeline: { items: page.items.map(toProtocolItem), hasMore: page.hasMore || (this.history !== null && (await this.history.hasOlder(request.sessionId))), nextSeq: page.headSeq, resetSeq: page.resetSeq },
      notices: interactions.map(noticeOf),
      approvals: [],
      queue: queue.items.length > 0 || queue.revision > 0 ? queueRules.queueState(queue) : null,
      planning: planning === null ? null : planningWire(planning),
      goalState: goal === null ? null : goalWire(goal, session.takeover),
      state: this.state(session, selections),
      runtimeCapabilities: capabilities,
      catalogs: catalogs ?? {},
    }
  }

  /** `store.read`: paged history by `orderSeq`; paging back past what is stored projects older native history. */
  public async read(request: { sessionId: string; mode: 'latest' | 'before' | 'after'; cursor?: number | null; limit?: number; byteBudget?: number }): Promise<StoreReadResponse> {
    await this.session(request.sessionId)
    const limit = request.limit ?? SNAPSHOT_LIMIT
    const cursor = request.cursor ?? null
    const readPage = () => this.store.timeline.read(request.sessionId, request.mode, cursor, limit, request.byteBudget ?? PAGE_BUDGET)
    if (request.mode === 'latest') await this.history?.ensureLatest(request.sessionId)
    let page = await readPage()
    if (request.mode !== 'after' && !page.hasMore && page.items.length < limit && this.history !== null) {
      if (await this.history.ensureBefore(request.sessionId, request.mode === 'before' ? cursor : null, limit)) page = await readPage()
    }
    const hasMore = page.hasMore || (request.mode !== 'after' && this.history !== null && (await this.history.hasOlder(request.sessionId)))
    return {
      items: page.items.map(item => toProtocolItem(item) as unknown as Record<string, unknown>),
      headSeq: page.headSeq,
      resetSeq: page.resetSeq,
      hasMore,
      oldestOrderSeq: page.oldestOrderSeq,
    }
  }

  /** `store.changesSince`: the cursor-recovery path behind `/events?after=seq:N`. */
  public async changesSince(request: { sessionId: string; afterSeq: number; limit?: number; byteBudget?: number }): Promise<ChangesSinceResponse> {
    await this.session(request.sessionId)
    const page = await this.store.timeline.changesSince(request.sessionId, request.afterSeq, request.limit ?? 500, request.byteBudget ?? PAGE_BUDGET)
    if (page.snapshotRequired) return { events: [], toSeq: page.headSeq, resetSeq: page.resetSeq, complete: false, snapshotRequired: true }
    return { events: timelineEvents(request.sessionId, page.items, this.now()), toSeq: page.toSeq, resetSeq: page.resetSeq, complete: page.complete, snapshotRequired: false }
  }

  /** `session.notices`: the current interactions, replacing whatever a reconnecting client holds. */
  public async notices(request: { sessionId: string }): Promise<Record<string, unknown>> {
    await this.session(request.sessionId)
    return { sessionId: request.sessionId, notices: (await this.store.interactions.list(request.sessionId, true)).map(noticeOf) }
  }

  /** The native report of an unopened session, overlaid with what an open session's Runtime has selected now. */
  private async selections(sessionId: string): Promise<Record<string, string> | null> {
    const [native, catalogs] = await Promise.all([
      this.facts.selections?.(sessionId) ?? Promise.resolve(null),
      this.facts.catalogs(sessionId).catch(() => null),
    ])
    const live: Record<string, string> = {}
    const current = catalogs?.selections
    if (current !== null && typeof current === 'object') {
      for (const [key, value] of Object.entries(current as Record<string, unknown>)) if (typeof value === 'string') live[key] = value
    }
    return native === null && Object.keys(live).length === 0 ? null : { ...(native ?? {}), ...live }
  }

  private state(session: Session, selections: Record<string, string> | null): Record<string, unknown> {
    return runtimeStateWire(session, selections)
  }

  /** A session capability (`ProtocolCapabilitySet` item) the Runtime declares and can use now. */
  private async capability(sessionId: string, capabilityId: string): Promise<Record<string, unknown> | null> {
    const set = await this.facts.sessionCapabilities(sessionId).catch(() => null)
    const items = Array.isArray(set?.capabilities) ? (set.capabilities as Record<string, unknown>[]) : []
    const item = items.find(entry => entry.capabilityId === capabilityId)
    return item !== undefined && item.supported === true && item.available !== false ? item : null
  }

  /** `PlanningState` in protocol 1.2, with the commands the session's capabilities allow. */
  private async planningState(session: Session): Promise<Record<string, unknown>> {
    const stored = await this.store.planning.load(session.sessionId)
    const [modes, review] = await Promise.all([this.capability(session.sessionId, 'session.planning'), this.capability(session.sessionId, 'session.plan_review')])
    const state = stored ?? initialPlanning(session.sessionId, session.runtimeType, '')
    return { ...planningWire(state), runtimeId: session.runtimeId, capabilities: planningCapabilities({ modes: modes !== null, review: review !== null }) }
  }

  /** `GoalState` in protocol 1.2. Before the Runtime reported a goal, the actions its capabilities declare. */
  private async goalState(session: Session): Promise<Record<string, unknown>> {
    const stored = await this.store.goals.load(session.sessionId)
    if (stored !== null) return goalWire(stored, session.takeover)
    const capability = await this.capability(session.sessionId, 'session.goal')
    const declared = (capability?.parameters as { actions?: unknown } | undefined)?.actions
    const actions = capability === null ? null : Array.isArray(declared) ? declared.map(String) : [...GOAL_ACTIONS]
    return goalWire(unobservedGoalState({ sessionId: session.sessionId, runtime: session.runtimeType, runtimeId: session.runtimeId, externalSessionId: session.externalSessionId }, actions), session.takeover)
  }

  /**
   * `Sessions/state`: `part: "planning"` answers `{planning}`, `part: "goal"` answers `{goal}` (the v2 client
   * shapes the Server validates); without `part`, the runtime state `{state}` together with both parts.
   */
  public async sessionState(request: { sessionId: string; part?: string | null }): Promise<Record<string, unknown>> {
    const session = await this.session(request.sessionId)
    if (request.part === 'planning') return { planning: await this.planningState(session) }
    if (request.part === 'goal') return { goal: await this.goalState(session) }
    const [selections, planning, goal] = await Promise.all([this.selections(request.sessionId), this.planningState(session), this.goalState(session)])
    return { state: this.state(session, selections), planning, goal }
  }

  public async capabilities(request: { sessionId: string }): Promise<Record<string, unknown>> {
    await this.session(request.sessionId)
    return { sessionId: request.sessionId, capabilitySet: await this.facts.sessionCapabilities(request.sessionId) }
  }

  public async queue(request: { sessionId: string }): Promise<Record<string, unknown>> {
    await this.session(request.sessionId)
    return { queue: queueRules.queueState(await this.store.queues.get(request.sessionId)) }
  }

  public async catalogs(request: { sessionId: string }): Promise<Record<string, unknown>> {
    await this.session(request.sessionId)
    return { sessionId: request.sessionId, catalogs: (await this.facts.catalogs(request.sessionId)) ?? {} }
  }

  /**
   * `store.planDocument`: with `planId` and `revision`, that immutable revision as `{document}`; without
   * `planId`, every revision as `{plans}`, newest first. A missing revision is `plan_document_not_found`.
   */
  public async planDocument(request: { sessionId: string; planId?: string | null; revision?: number | null }): Promise<Record<string, unknown>> {
    await this.session(request.sessionId)
    if (request.planId === undefined || request.planId === null || request.planId === '') {
      const state = await this.store.planning.load(request.sessionId)
      const documents = await Promise.all([...(state?.proposals ?? [])].reverse().map(meta => this.store.planning.document(request.sessionId, meta.planId, meta.revision)))
      return { plans: documents.filter((document): document is PlanDocument => document !== null) }
    }
    const revision = Number(request.revision)
    const document = Number.isInteger(revision) ? await this.store.planning.document(request.sessionId, request.planId, revision) : null
    if (document === null) {
      const error = new Error(`plan ${request.planId} revision ${String(request.revision)} not found`) as Error & { code: string }
      error.code = 'plan_document_not_found'
      throw error
    }
    return { document }
  }

  /** `workspace.preparation.get`: phase, model catalog, Agent options and open requests. */
  public async workspacePreparation(request: { preparationId: string }): Promise<Record<string, unknown>> {
    if (this.workflows === null) throw Object.assign(new Error('workspace preparation is not available on this device'), { code: 'workflow_unsupported' })
    return this.workflows.view(request.preparationId)
  }

  /** `session.creation.get` of a creation that consumed a preparation. */
  public async creation(request: { createOperationId: string }): Promise<Record<string, unknown>> {
    if (this.workflows === null) throw Object.assign(new Error('workspace preparation is not available on this device'), { code: 'workflow_unsupported' })
    return this.workflows.creationView(request.createOperationId)
  }

  /** `Commands/status`: read-only receipt lookup; never executes anything. */
  public async commandStatus(request: { commandId: string }): Promise<CommandStatusResponse> {
    const record = await this.store.commands.get(request.commandId)
    if (record === null) return { commandId: request.commandId, known: false, outcome: null }
    return {
      commandId: record.commandId,
      known: true,
      outcome: record.outcome,
      r: record.result,
      e: record.error === null ? null : { code: record.error.code, ...(record.error.message !== undefined ? { message: record.error.message } : {}), ...(record.error.retryable !== undefined ? { retryable: record.error.retryable } : {}) },
    }
  }
}

/** The client-shaped notice of an interaction, with its current status. */
export function noticeOf(interaction: Interaction): Record<string, unknown> {
  const status = interaction.state === 'responding' ? 'responding' : interaction.state === 'resolved' ? 'resolved' : interaction.state === 'expired' ? 'expired' : 'open'
  return { ...interaction.payload, noticeId: interaction.noticeId, sessionId: interaction.sessionId, status, resolvedAt: interaction.resolvedAt }
}
