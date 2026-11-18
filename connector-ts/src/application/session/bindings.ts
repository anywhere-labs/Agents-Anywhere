import type { TimelineDraft } from '../../domain/conversation/index.js'
import { Coalescer } from '../coalescer.js'
import { UseCaseError } from '../errors.js'
import type { RuntimeEvent, RuntimeSession } from '../ports/index.js'
import { TimelineProjector } from '../projection.js'
import type { SessionKernel } from './kernel.js'

/** `planningIntent` / `goalIntent` of a new session (create-and-start; a prepared creation takes `planningIntent`). */
export interface CreationIntent {
  readonly mode: 'plan' | 'goal'
  readonly operationId: string
}

/** A Runtime event the session reports live and keeps nowhere (`runtime.status` with the event in `fact`). */
export type LiveFact = Extract<RuntimeEvent, { type: 'writer.changed' | 'config.updated' | 'commands.updated' | 'capabilities.changed' | 'usage.updated' | 'background.updated' }>

/** How a hand-off opens a new Runtime session; kept with the delivery (`PendingDelivery.open`) across a restart. */
export interface OpenSpec {
  readonly cwd: string
  readonly title?: string
  readonly selections?: Record<string, string | null>
  readonly configuration?: Record<string, string | boolean>
  readonly planningIntent?: CreationIntent
  readonly goalIntent?: CreationIntent
}

/**
 * A Runtime session a workspace preparation opened before the session existed (`PreparationService`): the session
 * engine adopts it when it opens the session instead of starting a new one.
 */
export interface PreparedHandOver {
  /**
   * The prepared Runtime session under the session's id, with its event stream (the preparation consumed it
   * until now); null when the Agent session is gone, and the engine opens a new one instead.
   */
  adopt(sessionId: string): Promise<{ readonly session: RuntimeSession; readonly events: AsyncIterable<RuntimeEvent> } | null>
  /** Not adopted after all (the creation failed, the Connector stops). */
  discard(): Promise<void>
}

type Event<T extends RuntimeEvent['type']> = Extract<RuntimeEvent, { type: T }>

/** The use cases a session's Runtime events lead to, beyond the timeline projection the binding does itself. */
export interface SessionEventSink {
  settleDeliveryStarted(sessionId: string, clientMessageId: string, userItemId: string | null): Promise<void>
  adoptUserEcho(sessionId: string, clientMessageId: string, itemId: string): Promise<void>
  onTurnStarted(sessionId: string, turnId: string, clientMessageId: string | null): Promise<void>
  onTurnEnded(sessionId: string, turnId: string, outcome: 'completed' | 'interrupted' | 'failed', message: string | null): Promise<void>
  onInteractionOpened(sessionId: string, event: Event<'interaction.opened'>): Promise<void>
  onInteractionResolved(sessionId: string, interactionId: string, resolution: 'answered' | 'withdrawn' | 'expired'): Promise<void>
  onPlanUpdated(sessionId: string, event: Event<'plan.updated'>): Promise<void>
  onPlanningMode(sessionId: string, mode: 'plan' | 'normal'): Promise<void>
  onGoalUpdated(sessionId: string, wire: Record<string, unknown> | null): Promise<void>
  onLiveFact(sessionId: string, event: LiveFact): void
  onSessionLost(sessionId: string, error: { code: string; message: string }): Promise<void>
}

/**
 * One session's binding to its Runtime: the event loop that projects Runtime events into the store, with the
 * streaming coalescer in front of the commits.
 */
export class SessionBinding {
  public readonly projector: TimelineProjector
  private readonly coalescer: Coalescer
  private resetBuffer: TimelineDraft[] | null = null
  private loop: Promise<void> | null = null
  private closed = false

  public constructor(
    private readonly kernel: SessionKernel,
    private readonly sink: SessionEventSink,
    public readonly session: RuntimeSession,
    runtimeType: string,
    latest: Parameters<typeof TimelineProjector.prototype.remember>[0] | null,
    /** The session's events when someone else consumed them first (a prepared session's relay). */
    private readonly events: AsyncIterable<RuntimeEvent> = session.events,
  ) {
    const deps = kernel.deps
    this.projector = new TimelineProjector(runtimeType, session.nativeSessionId, latest, () => deps.clock.nowIso())
    this.coalescer = new Coalescer(ids => this.enqueueFlush(ids), deps.coalesceMs ?? 100, () => deps.clock.nowMs())
  }

  public start(): void {
    this.loop ??= this.consume()
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.events) {
        if (this.closed) break
        try {
          await this.onEvent(event)
        } catch (error) {
          this.kernel.reportError(this.session.sessionId, error)
        }
      }
    } finally {
      await this.flushNow()
      this.coalescer.dispose()
      if (!this.closed) await this.sink.onSessionLost(this.session.sessionId, { code: 'runtime_session_closed', message: 'The Runtime closed the session.' })
    }
  }

  private readonly pending = new Map<string, TimelineDraft>()
  /** Commits run one after another, in the order the coalescer released them. */
  private chain: Promise<void> = Promise.resolve()

  private enqueueFlush(ids: string[]): void {
    const drafts = ids.map(id => this.pending.get(id)).filter((draft): draft is TimelineDraft => draft !== undefined)
    for (const id of ids) this.pending.delete(id)
    if (drafts.length === 0) return
    this.chain = this.chain
      .then(async () => {
        await this.kernel.commit(this.session.sessionId, { upserts: drafts })
      })
      .catch(error => this.kernel.reportError(this.session.sessionId, error))
  }

  /** Commits everything pending now and waits for it (turn end, interaction opened). */
  public async flushNow(): Promise<void> {
    for (const id of this.pending.keys()) this.coalescer.mark(id)
    this.coalescer.flush()
    await this.chain
  }

  private stage(draft: TimelineDraft, immediate: boolean): void {
    if (this.resetBuffer !== null) {
      this.resetBuffer = [...this.resetBuffer.filter(entry => entry.id !== draft.id), draft]
      return
    }
    this.pending.set(draft.id, draft)
    this.coalescer.mark(draft.id)
    if (immediate) this.coalescer.flush()
  }

  private async onEvent(event: RuntimeEvent): Promise<void> {
    const sessionId = this.session.sessionId
    switch (event.type) {
      case 'message.delta':
      case 'message.completed':
      case 'tool.started':
      case 'tool.updated':
      case 'notice': {
        let fresh = false
        if (!this.projector.knows(event.itemId)) {
          const stored = await this.kernel.deps.store.timeline.get(sessionId, event.itemId)
          if (stored !== null) this.projector.remember(stored)
          fresh = stored === null
        }
        // A replayed history page is not a new error.
        if (event.type === 'notice' && event.kind === 'error' && fresh && this.resetBuffer === null) {
          const session = await this.kernel.deps.store.sessions.get(sessionId)
          if (session !== null) this.kernel.countUsage(session, 'runtime.error')
        }
        const draft = this.projector.apply(event)
        const streaming = event.type === 'message.delta' || (event.type === 'tool.updated' && draft.status === 'running')
        this.stage(draft, !streaming)
        if ((event.type === 'message.completed' || event.type === 'message.delta') && event.role === 'user' && event.clientMessageId !== undefined) {
          await this.flushNow()
          await this.sink.settleDeliveryStarted(sessionId, event.clientMessageId, event.itemId)
          await this.sink.adoptUserEcho(sessionId, event.clientMessageId, event.itemId)
        }
        return
      }
      case 'turn.started':
        await this.flushNow()
        await this.sink.onTurnStarted(sessionId, event.turnId, event.clientMessageId ?? null)
        return
      case 'turn.ended': {
        const settled = this.projector.settleOpen(event.reason === 'cancelled' ? 'cancelled' : event.reason === 'failed' || event.reason === 'refusal' ? 'failed' : 'done')
        for (const draft of settled) this.pending.set(draft.id, draft)
        await this.flushNow()
        this.projector.compact()
        await this.sink.onTurnEnded(sessionId, event.turnId, event.reason === 'failed' || event.reason === 'refusal' ? 'failed' : event.reason === 'cancelled' ? 'interrupted' : 'completed', event.error?.message ?? null)
        return
      }
      case 'interaction.opened':
        await this.flushNow()
        await this.sink.onInteractionOpened(sessionId, event)
        return
      case 'interaction.resolved':
        await this.sink.onInteractionResolved(sessionId, event.interactionId, event.resolution)
        return
      case 'plan.updated':
        await this.sink.onPlanUpdated(sessionId, event)
        return
      case 'planning.mode_changed':
        await this.sink.onPlanningMode(sessionId, event.mode)
        return
      case 'goal.updated':
        await this.sink.onGoalUpdated(sessionId, event.goal as unknown as Record<string, unknown> | null)
        return
      case 'session.info':
        if (event.title !== undefined) await this.kernel.patchSession(sessionId, { nativeTitle: event.title })
        return
      case 'history.reset':
        if (event.phase === 'begin') {
          await this.flushNow()
          this.resetBuffer = []
        } else if (event.phase === 'abort') {
          this.resetBuffer = null
        } else if (this.resetBuffer !== null) {
          const drafts = this.resetBuffer
          this.resetBuffer = null
          await this.kernel.commit(sessionId, { upserts: drafts, replace: {} })
        }
        return
      case 'writer.changed':
      case 'config.updated':
      case 'commands.updated':
      case 'capabilities.changed':
      case 'usage.updated':
      case 'background.updated':
        this.sink.onLiveFact(sessionId, event)
        return
      case 'session.lost':
        await this.flushNow()
        this.closed = true
        await this.sink.onSessionLost(sessionId, event.error)
        return
    }
  }

  public async close(): Promise<void> {
    this.closed = true
    await this.flushNow()
    this.coalescer.dispose()
    await this.session.close().catch(() => undefined)
  }
}

/**
 * The open Runtime sessions of this device's Conversations, opened (or resumed) on first use, and the prepared
 * Runtime sessions waiting for their session to open.
 */
export class RuntimeBindings {
  private readonly bindings = new Map<string, SessionBinding>()
  private readonly opening = new Map<string, Promise<SessionBinding>>()
  /** Prepared Runtime sessions waiting for their session to open (workspace preparation), by session id. */
  private readonly prepared = new Map<string, PreparedHandOver>()

  public constructor(private readonly kernel: SessionKernel, private readonly sink: SessionEventSink) {}

  /**
   * The open Runtime session, opening (or resuming) it on first use: after a Connector restart an ACP session
   * resumes on the next operation instead of asking the user to click "resume" (04-connector.md §5.4).
   */
  public async binding(sessionId: string): Promise<SessionBinding> {
    const existing = this.bindings.get(sessionId)
    if (existing !== undefined) return existing
    let pending = this.opening.get(sessionId)
    if (pending === undefined) {
      pending = this.open(sessionId).finally(() => this.opening.delete(sessionId))
      this.opening.set(sessionId, pending)
    }
    return pending
  }

  /** The binding when the session is open; never opens one. */
  public get(sessionId: string): SessionBinding | undefined {
    return this.bindings.get(sessionId)
  }

  /** Forgets an open session (the Runtime lost it) and returns its binding. */
  public take(sessionId: string): SessionBinding | undefined {
    const binding = this.bindings.get(sessionId)
    this.bindings.delete(sessionId)
    return binding
  }

  /** A workspace preparation hands its Runtime session over to the session it creates (opened on first use). */
  public offerPrepared(sessionId: string, handOver: PreparedHandOver): void {
    const previous = this.prepared.get(sessionId)
    this.prepared.set(sessionId, handOver)
    if (previous !== undefined && previous !== handOver) void previous.discard().catch(error => this.kernel.reportError(sessionId, error))
  }

  /** The creation did not go ahead: close the prepared Runtime session nobody adopted. */
  public async withdrawPrepared(sessionId: string): Promise<void> {
    const offered = this.prepared.get(sessionId)
    this.prepared.delete(sessionId)
    await offered?.discard()
  }

  /** Opens a new session's Runtime session as `spec` describes, unless it is open already. */
  public async openNew(sessionId: string, spec: OpenSpec): Promise<void> {
    if (this.bindings.has(sessionId)) return
    const binding = await this.open(sessionId, spec)
    this.bindings.set(sessionId, binding)
  }

  private async open(sessionId: string, spec?: OpenSpec): Promise<SessionBinding> {
    const deps = this.kernel.deps
    const session = await this.kernel.requireSession(sessionId)
    const offered = this.prepared.get(sessionId)
    this.prepared.delete(sessionId)
    // A prepared session is adopted as it is: no second `session/new`, no cold start on the first message.
    const adopted = offered !== undefined && session.externalSessionId === null ? await offered.adopt(sessionId).catch(async error => {
      await offered.discard().catch(() => undefined)
      throw error
    }) : null
    if (offered !== undefined && adopted === null) await offered.discard().catch(error => this.kernel.reportError(sessionId, error))
    let runtimeSession: RuntimeSession
    let events: AsyncIterable<RuntimeEvent> | undefined
    if (adopted !== null) {
      runtimeSession = adopted.session
      events = adopted.events
    } else {
      const handle = await deps.runtimes.handle(session.runtimeId)
      if (handle === null) throw new UseCaseError('runtime_unavailable', `runtime ${session.runtimeId} is not available on this device`)
      // History first: live items then count up from the newest projected one.
      if (session.externalSessionId !== null && deps.history !== undefined) {
        await deps.history.ensureLatest(sessionId).catch(error => this.kernel.reportError(sessionId, error))
      }
      runtimeSession = session.externalSessionId !== null
        ? await handle.open({ kind: 'existing', ref: { nativeSessionId: session.externalSessionId, ...(session.cwd ? { cwd: session.cwd } : {}) } }, { sessionId, replay: 'none' })
        : await handle.open({
          kind: 'new',
          spec: {
            cwd: spec?.cwd ?? session.cwd ?? '.',
            ...(spec?.title ? { title: spec.title } : {}),
            ...(spec?.selections !== undefined ? { selections: spec.selections } : {}),
          },
        }, { sessionId, replay: 'none' })
      if (session.externalSessionId === null && spec?.configuration !== undefined) await configureNew(runtimeSession, spec.configuration)
    }
    if (session.externalSessionId !== runtimeSession.nativeSessionId) {
      await this.kernel.patchSession(sessionId, { externalSessionId: runtimeSession.nativeSessionId })
    }
    const binding = new SessionBinding(this.kernel, this.sink, runtimeSession, session.runtimeType, await deps.store.timeline.latest(sessionId), events ?? runtimeSession.events)
    this.bindings.set(sessionId, binding)
    binding.start()
    return binding
  }

  public async close(): Promise<void> {
    const offered = [...this.prepared.values()]
    this.prepared.clear()
    await Promise.all([...this.bindings.values()].map(binding => binding.close()))
    await Promise.all(offered.map(handOver => handOver.discard().catch(() => undefined)))
    this.bindings.clear()
  }

  /** The open Runtime session of a Conversation, if any (snapshot capabilities come from it). */
  public boundSession(sessionId: string): RuntimeSession | null {
    return this.bindings.get(sessionId)?.session ?? null
  }

  /** Whether a Conversation has an open Runtime session (native history then comes from live events). */
  public isBound(sessionId: string): boolean {
    return this.bindings.has(sessionId)
  }
}

/** A new session's frozen Agent options (runtime-workflows 1.2 `configuration`); a refused value fails the creation. */
async function configureNew(runtimeSession: RuntimeSession, configuration: Readonly<Record<string, string | boolean>>): Promise<void> {
  try {
    for (const [optionId, value] of Object.entries(configuration)) await runtimeSession.configure({ optionId, value })
  } catch (error) {
    await runtimeSession.close().catch(() => undefined)
    throw error
  }
}
