import { createHash } from 'node:crypto'

import {
  ConversationError,
  admitMessage,
  admitSteer,
  interaction as interactionRules,
  queue as queueRules,
  statusAfterTurn,
  type QueueAttachment,
  type QueueMode,
  type Session,
  type SessionQueue,
  type TimelineDraft,
} from '../domain/conversation/index.js'
import { checkRequest as checkGoalRequest, initialGoalState, observe as observeGoal, type GoalRequest } from '../domain/goals/index.js'
import {
  finalize as finalizePlan,
  initialPlanning,
  observeMode,
  requireReview,
  setReviewStatus,
  type PlanningState,
} from '../domain/planning/index.js'
import { Coalescer } from './coalescer.js'
import { TimelineProjector } from './projection.js'
import type {
  ChangeFeed,
  Clock,
  ConversationStore,
  IdSource,
  LiveEvents,
  PromptAttachment,
  QueueOp,
  RuntimeEvent,
  RuntimeHandles,
  RuntimeSession,
  SessionCommit,
} from './ports/index.js'

export interface ConversationDeps {
  readonly store: ConversationStore
  readonly feed: ChangeFeed
  readonly live: LiveEvents
  readonly runtimes: RuntimeHandles
  readonly clock: Clock
  readonly ids: IdSource
  /** Streaming commit window per item (v2: 100 ms). */
  readonly coalesceMs?: number
  /** Resolves a Server file id to a local path once the attachment is downloaded (workspace). */
  readonly attachments?: (sessionId: string, ref: AttachmentRef) => Promise<PromptAttachment>
  /** Projects the latest page of an existing native session before it is opened (04-connector.md §6.6). */
  readonly history?: { ensureLatest(sessionId: string): Promise<void> }
}

export interface AttachmentRef {
  fileId: string
  name: string
  mediaType: string
  size: number
  sha256?: string | null
}

export interface SendMessageCommand {
  sessionId: string
  clientMessageId: string
  content: string
  attachments?: AttachmentRef[]
  queue?: QueueMode | null
}

export interface CommandContext {
  readonly commandId: string | null
  /** Digest the client computed over the plaintext; the device computes one when absent. */
  readonly inputDigest: string | null
  /** Who asked (`usr_…`), for `createdBy` of queue items. */
  readonly actor: string
}

export interface CreateSessionCommand {
  sessionId: string
  runtimeId: string
  runtimeType: string
  cwd: string
  title?: string | null
  selections?: Record<string, string | null>
  clientMessageId: string
  content: string
  attachments?: AttachmentRef[]
  takeover?: boolean
}

export type SendResult =
  | { delivery: 'accepted'; clientMessageId: string }
  | { delivery: 'queued'; clientMessageId: string; item: Record<string, unknown>; queuePosition: number; queue: Record<string, unknown> }
  | { delivery: 'duplicate'; clientMessageId: string; state: string }

/** A use-case failure carrying the AA error code the Server and clients expect. */
export class UseCaseError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'UseCaseError'
  }
}

/** Id of a user message the platform writes itself (failed sends, Runtimes that do not name the item). */
export function platformUserItemId(sessionId: string, clientMessageId: string): string {
  return `aa_user_${createHash('sha256').update(`${sessionId}\0${clientMessageId}`).digest('hex').slice(0, 32)}`
}

function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

/**
 * One session's binding to its Runtime: the event loop that projects Runtime events into the store, with the
 * streaming coalescer in front of the commits.
 */
class SessionBinding {
  public readonly projector: TimelineProjector
  private readonly coalescer: Coalescer
  private resetBuffer: TimelineDraft[] | null = null
  private loop: Promise<void> | null = null
  private closed = false

  public constructor(
    private readonly service: ConversationService,
    public readonly session: RuntimeSession,
    runtimeType: string,
    latest: Parameters<typeof TimelineProjector.prototype.remember>[0] | null,
    private readonly deps: ConversationDeps,
  ) {
    this.projector = new TimelineProjector(runtimeType, session.nativeSessionId, latest, () => deps.clock.nowIso())
    this.coalescer = new Coalescer(ids => this.enqueueFlush(ids), deps.coalesceMs ?? 100, () => deps.clock.nowMs())
  }

  public start(): void {
    this.loop ??= this.consume()
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.session.events) {
        if (this.closed) break
        try {
          await this.onEvent(event)
        } catch (error) {
          this.service.reportError(this.session.sessionId, error)
        }
      }
    } finally {
      await this.flushNow()
      this.coalescer.dispose()
      if (!this.closed) await this.service.onSessionLost(this.session.sessionId, { code: 'runtime_session_closed', message: 'The Runtime closed the session.' })
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
        await this.service.commit(this.session.sessionId, { upserts: drafts })
      })
      .catch(error => this.service.reportError(this.session.sessionId, error))
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
        if (!this.projector.knows(event.itemId)) {
          const stored = await this.deps.store.timeline.get(sessionId, event.itemId)
          if (stored !== null) this.projector.remember(stored)
        }
        const draft = this.projector.apply(event)
        const streaming = event.type === 'message.delta' || (event.type === 'tool.updated' && draft.status === 'running')
        this.stage(draft, !streaming)
        if ((event.type === 'message.completed' || event.type === 'message.delta') && event.role === 'user' && event.clientMessageId !== undefined) {
          await this.flushNow()
          await this.service.settleDeliveryStarted(sessionId, event.clientMessageId, event.itemId)
          await this.service.adoptUserEcho(sessionId, event.clientMessageId, event.itemId)
        }
        return
      }
      case 'turn.started':
        await this.flushNow()
        await this.service.onTurnStarted(sessionId, event.turnId, event.clientMessageId ?? null)
        return
      case 'turn.ended': {
        const settled = this.projector.settleOpen(event.reason === 'cancelled' ? 'cancelled' : event.reason === 'failed' || event.reason === 'refusal' ? 'failed' : 'done')
        for (const draft of settled) this.pending.set(draft.id, draft)
        await this.flushNow()
        this.projector.compact()
        await this.service.onTurnEnded(sessionId, event.turnId, event.reason === 'failed' || event.reason === 'refusal' ? 'failed' : event.reason === 'cancelled' ? 'interrupted' : 'completed', event.error?.message ?? null)
        return
      }
      case 'interaction.opened':
        await this.flushNow()
        await this.service.onInteractionOpened(sessionId, event)
        return
      case 'interaction.resolved':
        await this.service.onInteractionResolved(sessionId, event.interactionId, event.resolution)
        return
      case 'plan.updated':
        await this.service.onPlanUpdated(sessionId, event)
        return
      case 'planning.mode_changed':
        await this.service.onPlanningMode(sessionId, event.mode)
        return
      case 'goal.updated':
        await this.service.onGoalUpdated(sessionId, event.goal as unknown as Record<string, unknown> | null)
        return
      case 'session.info':
        if (event.title !== undefined) await this.service.patchSession(sessionId, { nativeTitle: event.title })
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
          await this.service.commit(sessionId, { upserts: drafts, replace: {} })
        }
        return
      case 'writer.changed':
      case 'config.updated':
      case 'commands.updated':
      case 'capabilities.changed':
      case 'usage.updated':
      case 'background.updated':
        this.service.onLiveFact(sessionId, event)
        return
      case 'session.lost':
        await this.flushNow()
        this.closed = true
        await this.service.onSessionLost(sessionId, event.error)
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
 * The Conversation application service: every state-changing use case (06-protocols.md §2.4 `Commands/*`) and
 * the reaction to Runtime events. Single writer per device; per-session work is serialized.
 */
export class ConversationService {
  private readonly bindings = new Map<string, SessionBinding>()
  private readonly opening = new Map<string, Promise<SessionBinding>>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly errors: { sessionId: string; error: unknown }[] = []

  public constructor(private readonly deps: ConversationDeps) {}

  /** Errors swallowed by background work (event loops, dispatch); exposed for logs and tests. */
  public get backgroundErrors(): readonly { sessionId: string; error: unknown }[] {
    return this.errors
  }

  public reportError(sessionId: string, error: unknown): void {
    this.errors.push({ sessionId, error })
    if (this.errors.length > 100) this.errors.shift()
  }

  /** Runs `work` after every earlier piece of work for the same session. */
  private serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(work, work)
    const tail = next.catch(() => undefined)
    this.chains.set(sessionId, tail)
    void tail.then(() => {
      if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId)
    })
    return next
  }

  // ---------------------------------------------------------------- commits

  /** Commits a timeline change and publishes it on the ChangeFeed. */
  public async commit(sessionId: string, change: { upserts: TimelineDraft[]; replace?: { range?: { afterOrderSeq: number | null; throughOrderSeq: number | null } }; session?: Parameters<ConversationStore['sessions']['update']>[1] }): Promise<SessionCommit> {
    const commit = await this.deps.store.timeline.apply(sessionId, { ...change, at: this.deps.clock.nowIso() })
    this.publish(commit)
    return commit
  }

  public async patchSession(sessionId: string, patch: Parameters<ConversationStore['sessions']['update']>[1]): Promise<SessionCommit> {
    const commit = await this.deps.store.sessions.update(sessionId, patch)
    this.publish(commit)
    return commit
  }

  private publish(commit: SessionCommit): void {
    if (commit.toSeq >= commit.fromSeq && (commit.changed.length > 0 || commit.deleted.length > 0 || commit.reset)) {
      this.deps.feed.publish({
        sessionId: commit.session.sessionId,
        fromSeq: commit.fromSeq,
        toSeq: commit.toSeq,
        resetSeq: commit.session.clock.resetSeq,
        reset: commit.reset,
      })
    }
    if (commit.summary !== null) this.deps.live.emit('runtime.status', { sessionId: commit.session.sessionId, event: 'session.status', status: commit.session.status })
  }

  private async requireSession(sessionId: string): Promise<Session> {
    const session = await this.deps.store.sessions.get(sessionId)
    if (session === null) throw new UseCaseError('session_not_found', `session ${sessionId} is not on this device`)
    return session
  }

  // ---------------------------------------------------------------- runtime binding

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

  private async open(sessionId: string, spec?: { cwd: string; title?: string | null; selections?: Record<string, string | null> }): Promise<SessionBinding> {
    const session = await this.requireSession(sessionId)
    const handle = await this.deps.runtimes.handle(session.runtimeId)
    if (handle === null) throw new UseCaseError('runtime_unavailable', `runtime ${session.runtimeId} is not available on this device`)
    // History first: live items then count up from the newest projected one.
    if (session.externalSessionId !== null && this.deps.history !== undefined) {
      await this.deps.history.ensureLatest(sessionId).catch(error => this.reportError(sessionId, error))
    }
    const runtimeSession = session.externalSessionId !== null
      ? await handle.open({ kind: 'existing', ref: { nativeSessionId: session.externalSessionId } }, { sessionId, replay: 'none' })
      : await handle.open({
        kind: 'new',
        spec: {
          cwd: spec?.cwd ?? session.cwd ?? '.',
          ...(spec?.title ? { title: spec.title } : {}),
          ...(spec?.selections !== undefined ? { selections: spec.selections } : {}),
        },
      }, { sessionId, replay: 'none' })
    if (session.externalSessionId !== runtimeSession.nativeSessionId) {
      await this.patchSession(sessionId, { externalSessionId: runtimeSession.nativeSessionId })
    }
    const binding = new SessionBinding(this, runtimeSession, session.runtimeType, await this.deps.store.timeline.latest(sessionId), this.deps)
    this.bindings.set(sessionId, binding)
    binding.start()
    return binding
  }

  // ---------------------------------------------------------------- use cases

  /** `session.creation.begin`: the Server allocated the id; the device creates the Conversation and sends the first message. */
  public async createSession(command: CreateSessionCommand, context: CommandContext): Promise<SendResult> {
    return this.serial(command.sessionId, async () => {
      const at = this.deps.clock.nowIso()
      await this.deps.store.sessions.create({
        sessionId: command.sessionId,
        runtimeType: command.runtimeType,
        runtimeId: command.runtimeId,
        externalSessionId: null,
        cwd: command.cwd,
        nativeTitle: command.title ?? null,
        status: 'pending',
        sourceAvailability: 'available',
        takeover: command.takeover ?? true,
        at,
      })
      const received = await this.deps.store.deliveries.receive({
        sessionId: command.sessionId,
        clientMessageId: command.clientMessageId,
        inputDigest: context.inputDigest ?? digestOf({ content: command.content, attachments: command.attachments ?? [] }),
        userItem: null,
        enqueue: null,
        commandId: context.commandId,
        at,
      })
      if (received.duplicate) return { delivery: 'duplicate', clientMessageId: command.clientMessageId, state: received.delivery.state }
      void this.serial(command.sessionId, async () => {
        try {
          if (!this.bindings.has(command.sessionId)) {
            const binding = await this.open(command.sessionId, { cwd: command.cwd, ...(command.title !== undefined ? { title: command.title } : {}), ...(command.selections !== undefined ? { selections: command.selections } : {}) })
            this.bindings.set(command.sessionId, binding)
          }
          await this.deliver(command.sessionId, command.clientMessageId, command.content, command.attachments ?? [])
        } catch (error) {
          await this.failDelivery(command.sessionId, command.clientMessageId, command.content, error)
        }
      })
      return { delivery: 'accepted', clientMessageId: command.clientMessageId }
    })
  }

  /** `session.sendMessage`: accepted once the delivery is on disk; the Runtime hand-off happens after the ack. */
  public async sendMessage(command: SendMessageCommand, context: CommandContext): Promise<SendResult> {
    return this.serial(command.sessionId, async () => {
      const session = await this.requireSession(command.sessionId)
      if (session.archived) throw new UseCaseError('session_archived', 'the session is archived')
      const existing = await this.deps.store.deliveries.get(command.sessionId, command.clientMessageId)
      const inputDigest = context.inputDigest ?? digestOf({ content: command.content, attachments: command.attachments ?? [] })
      if (existing !== null) {
        if (existing.inputDigest !== inputDigest) throw new ConversationError('delivery_conflict', `clientMessageId ${command.clientMessageId} was already used for a different message`)
        return { delivery: 'duplicate', clientMessageId: command.clientMessageId, state: existing.state }
      }
      const queue = await this.deps.store.queues.get(command.sessionId)
      const admission = admitMessage({ status: session.status, queueLength: queue.items.length, queue: command.queue ?? null, queueAvailable: session.takeover && !session.archived })
      if (admission.kind === 'reject') {
        throw new UseCaseError('session_busy', admission.legacy ? `session is ${admission.status}` : 'The session is busy.', { legacy: admission.legacy, status: admission.status })
      }
      const at = this.deps.clock.nowIso()
      const attachments: QueueAttachment[] = (command.attachments ?? []).map(ref => ({ fileId: ref.fileId, name: ref.name, mediaType: ref.mediaType, size: ref.size }))
      const received = await this.deps.store.deliveries.receive({
        sessionId: command.sessionId,
        clientMessageId: command.clientMessageId,
        inputDigest,
        userItem: null,
        enqueue: admission.kind === 'enqueue'
          ? {
            mode: admission.interrupt ? 'interrupt' : 'auto',
            item: { messageId: this.deps.ids.newId('qmsg_'), sessionId: command.sessionId, clientMessageId: command.clientMessageId, content: command.content, attachments, createdBy: context.actor, createdAt: at, updatedAt: at },
          }
          : null,
        commandId: context.commandId,
        at,
      })
      if (received.queue !== null && received.queueItem !== null) {
        const state = queueRules.queueState(received.queue)
        this.deps.live.emit('runtime.queue.updated', { sessionId: command.sessionId, queue: state })
        if (admission.kind === 'enqueue' && admission.interrupt) void this.serial(command.sessionId, () => this.interruptForQueue(command.sessionId))
        const item = state.items.find(entry => entry.messageId === received.queueItem?.messageId)
        return { delivery: 'queued', clientMessageId: command.clientMessageId, item: item as unknown as Record<string, unknown>, queuePosition: item?.position ?? 0, queue: state as unknown as Record<string, unknown> }
      }
      void this.serial(command.sessionId, async () => {
        try {
          await this.deliver(command.sessionId, command.clientMessageId, command.content, command.attachments ?? [])
        } catch (error) {
          await this.failDelivery(command.sessionId, command.clientMessageId, command.content, error)
        }
      })
      return { delivery: 'accepted', clientMessageId: command.clientMessageId }
    })
  }

  /** Hands an accepted delivery to the Runtime. Never retried on an unknown outcome. */
  private async deliver(sessionId: string, clientMessageId: string, content: string, refs: AttachmentRef[]): Promise<'started' | 'rejected' | 'unknown'> {
    const binding = await this.binding(sessionId)
    const at = this.deps.clock.nowIso()
    await this.deps.store.deliveries.transition(sessionId, clientMessageId, 'sending', { at })
    const attachments = this.deps.attachments === undefined ? [] : await Promise.all(refs.map(ref => this.deps.attachments!(sessionId, ref)))
    let acceptance
    try {
      acceptance = await binding.session.prompt({ text: content, ...(attachments.length > 0 ? { attachments } : {}) }, { deliveryId: clientMessageId, clientMessageId })
    } catch (error) {
      acceptance = { outcome: 'unknown' as const, error: { code: 'delivery_outcome_unknown', message: (error as Error).message } }
    }
    if (acceptance.outcome === 'accepted') {
      await this.settleDeliveryStarted(sessionId, clientMessageId, acceptance.userItemId ?? null, content)
      await this.writeUserMessage(sessionId, clientMessageId, content, acceptance.userItemId ?? null)
      if (acceptance.turnId !== undefined) await this.onTurnStarted(sessionId, acceptance.turnId, clientMessageId)
      return 'started'
    }
    const state = acceptance.outcome === 'rejected' ? 'rejected' : 'unknown'
    await this.deps.store.deliveries.transition(sessionId, clientMessageId, state, { at: this.deps.clock.nowIso(), errorCode: acceptance.error.code })
    await this.writeFailedUserMessage(sessionId, clientMessageId, content, acceptance.error.code, acceptance.error.message)
    return state
  }

  private async failDelivery(sessionId: string, clientMessageId: string, content: string, error: unknown): Promise<void> {
    this.reportError(sessionId, error)
    const current = await this.deps.store.deliveries.get(sessionId, clientMessageId)
    if (current === null) return
    const code = error instanceof UseCaseError ? error.code : 'runtime_unavailable'
    if (current.state === 'accepted' || current.state === 'queued') {
      await this.deps.store.deliveries.transition(sessionId, clientMessageId, 'rejected', { at: this.deps.clock.nowIso(), errorCode: code })
    } else if (current.state === 'sending') {
      await this.deps.store.deliveries.transition(sessionId, clientMessageId, 'unknown', { at: this.deps.clock.nowIso(), errorCode: 'delivery_outcome_unknown' })
    } else {
      return
    }
    await this.writeFailedUserMessage(sessionId, clientMessageId, content, code, (error as Error).message ?? String(error))
  }

  /** A send that never reached the Runtime is still shown, as a failed user message (v2 behaviour). */
  private async writeFailedUserMessage(sessionId: string, clientMessageId: string, text: string, code: string, message: string): Promise<void> {
    await this.putUserMessage(sessionId, platformUserItemId(sessionId, clientMessageId), clientMessageId, text, 'failed', { error: { code, message } })
  }

  /**
   * The user message of an accepted delivery, unless the Runtime already echoed it. The adapter's
   * `userItemId` follows the Runtime's v2 identity rule, so a later echo updates the same item.
   */
  private async writeUserMessage(sessionId: string, clientMessageId: string, text: string, userItemId: string | null): Promise<void> {
    const existing = await this.deps.store.timeline.findByClientMessageId(sessionId, clientMessageId)
    if (existing !== null && existing.role === 'user' && existing.status !== 'failed') return
    await this.putUserMessage(sessionId, userItemId ?? platformUserItemId(sessionId, clientMessageId), clientMessageId, text, 'done', {})
  }

  private async putUserMessage(sessionId: string, id: string, clientMessageId: string, text: string, status: 'done' | 'failed', extra: Record<string, unknown>): Promise<void> {
    const binding = this.bindings.get(sessionId)
    const at = this.deps.clock.nowIso()
    const draft: Omit<TimelineDraft, 'orderSeq'> = {
      id,
      type: 'message',
      status,
      role: 'user',
      content: { kind: 'markdown', format: 'markdown', text, isThinking: false, clientMessageId, ...(extra as Record<string, never>) },
      source: { runtime: binding === undefined ? 'platform' : 'platform', clientMessageId },
      createdAt: at,
      completedAt: at,
    }
    const stored = await this.deps.store.timeline.get(sessionId, id)
    const projector = binding?.projector ?? new TimelineProjector('platform', null, await this.deps.store.timeline.latest(sessionId), () => at)
    if (stored !== null) projector.remember(stored)
    await this.commit(sessionId, { upserts: [projector.platform(stored !== null ? { ...draft, orderSeq: stored.orderSeq, createdAt: stored.createdAt } : draft)] })
  }

  public async settleDeliveryStarted(sessionId: string, clientMessageId: string, _userItemId: string | null, _text?: string): Promise<void> {
    const current = await this.deps.store.deliveries.get(sessionId, clientMessageId)
    if (current === null || current.state === 'started') return
    if (current.state === 'accepted') await this.deps.store.deliveries.transition(sessionId, clientMessageId, 'sending', { at: this.deps.clock.nowIso() })
    const after = await this.deps.store.deliveries.get(sessionId, clientMessageId)
    if (after?.state === 'sending') await this.deps.store.deliveries.transition(sessionId, clientMessageId, 'started', { at: this.deps.clock.nowIso() })
  }

  /**
   * The Runtime echoed a user message under its own id after the platform wrote one under the platform id
   * (an adapter that did not report `userItemId`): keep the Runtime's item, drop the platform copy.
   */
  public async adoptUserEcho(sessionId: string, clientMessageId: string, itemId: string): Promise<void> {
    const platformId = platformUserItemId(sessionId, clientMessageId)
    if (itemId === platformId) return
    const copy = await this.deps.store.timeline.get(sessionId, platformId)
    if (copy === null || copy.status === 'failed') return
    const commit = await this.deps.store.timeline.apply(sessionId, { upserts: [], deletes: [platformId], at: this.deps.clock.nowIso() })
    this.publish(commit)
  }

  public async steer(command: SendMessageCommand, context: CommandContext): Promise<{ outcome: string }> {
    return this.serial(command.sessionId, async () => {
      const session = await this.requireSession(command.sessionId)
      const binding = await this.binding(command.sessionId)
      admitSteer({ status: session.status, steerSupported: binding.session.steer !== undefined })
      const at = this.deps.clock.nowIso()
      const received = await this.deps.store.deliveries.receive({
        sessionId: command.sessionId, clientMessageId: command.clientMessageId,
        inputDigest: context.inputDigest ?? digestOf({ steer: command.content }), userItem: null, enqueue: null, commandId: context.commandId, at,
      })
      if (received.duplicate) return { outcome: `duplicate:${received.delivery.state}` }
      await this.deps.store.deliveries.transition(command.sessionId, command.clientMessageId, 'sending', { at })
      const result = await binding.session.steer!({ text: command.content }, { deliveryId: command.clientMessageId, clientMessageId: command.clientMessageId })
      if (result.outcome === 'injected' || result.outcome === 'started_new_turn') {
        await this.deps.store.deliveries.transition(command.sessionId, command.clientMessageId, 'started', { at: this.deps.clock.nowIso() })
      } else if (result.outcome === 'rejected' || result.outcome === 'prompt_required') {
        await this.deps.store.deliveries.transition(command.sessionId, command.clientMessageId, 'rejected', { at: this.deps.clock.nowIso(), errorCode: result.outcome === 'rejected' ? result.error.code : 'prompt_required' })
      } else {
        await this.deps.store.deliveries.transition(command.sessionId, command.clientMessageId, 'unknown', { at: this.deps.clock.nowIso(), errorCode: result.error.code })
      }
      return { outcome: result.outcome }
    })
  }

  /** `session.select`: model, permission, mode or effort, through the Runtime's configuration options. */
  public async select(sessionId: string, change: { optionId: string; value: string | boolean }): Promise<Record<string, unknown>> {
    return this.serial(sessionId, async () => {
      await this.requireSession(sessionId)
      const binding = await this.binding(sessionId)
      const result = await binding.session.configure(change)
      this.deps.live.emit('runtime.status', { sessionId, event: 'config.updated', options: result.options as unknown as Record<string, unknown>[] })
      return { appliesFrom: result.appliesFrom }
    })
  }

  public async interrupt(sessionId: string): Promise<{ interrupted: boolean }> {
    const session = await this.requireSession(sessionId)
    const binding = this.bindings.get(sessionId) ?? await this.binding(sessionId)
    await binding.session.cancel(session.activeTurn?.turnId)
    if (session.status !== 'idle') await this.patchSession(sessionId, { status: 'stopping' })
    return { interrupted: true }
  }

  private async interruptForQueue(sessionId: string): Promise<void> {
    const session = await this.requireSession(sessionId)
    if (session.activeTurn === null || session.status === 'stopping') return
    const binding = this.bindings.get(sessionId)
    if (binding === undefined) return
    await binding.session.cancel(session.activeTurn.turnId)
  }

  /** `session.respondNotice`: first answer wins; forwarding failure reopens the interaction. */
  public async respondNotice(sessionId: string, noticeId: string, responseId: string, answer: Parameters<RuntimeSession['respond']>[1]): Promise<{ status: string }> {
    const decision = await this.deps.store.interactions.respond(sessionId, noticeId, responseId)
    if (decision.kind === 'duplicate') return { status: decision.interaction.state }
    try {
      const binding = await this.binding(sessionId)
      await binding.session.respond(noticeId, answer)
    } catch (error) {
      await this.deps.store.interactions.save(interactionRules.reopen(decision.interaction))
      throw error
    }
    return { status: 'responding' }
  }

  /** Queue management (`session.queue.*`). */
  public async queueOp(sessionId: string, op: Exclude<QueueOp, { kind: 'markSending' | 'markSent' | 'markFailed' | 'turnEnded' | 'dropForArchive' }>): Promise<Record<string, unknown>> {
    return this.serial(sessionId, async () => {
      const session = await this.requireSession(sessionId)
      if (!session.takeover) throw new UseCaseError('session_not_taken_over', 'Take over the session before changing its queue.')
      const before = await this.deps.store.queues.get(sessionId)
      const after = await this.deps.store.queues.apply(sessionId, op, this.deps.clock.nowIso())
      const state = queueRules.queueState(after)
      if (after.revision !== before.revision) this.deps.live.emit('runtime.queue.updated', { sessionId, queue: state })
      if (op.kind === 'sendNow') void this.serial(sessionId, () => this.interruptForQueue(sessionId))
      void this.serial(sessionId, () => this.dispatchNext(sessionId))
      return state as unknown as Record<string, unknown>
    })
  }

  /** Dispatches the head of the queue when the session is idle (single writer: no claim needed). */
  public async dispatchNext(sessionId: string): Promise<void> {
    const session = await this.deps.store.sessions.get(sessionId)
    if (session === null) return
    const queue = await this.deps.store.queues.get(sessionId)
    const decision = queueRules.nextDispatch(queue, session)
    if (decision.kind === 'interrupt') {
      await this.interruptForQueue(sessionId)
      return
    }
    if (decision.kind === 'wait') {
      if (decision.reason === 'archived') await this.applyQueue(sessionId, { kind: 'dropForArchive' })
      return
    }
    const item = decision.item
    await this.applyQueue(sessionId, { kind: 'markSending', messageId: item.messageId })
    let outcome: 'started' | 'rejected' | 'unknown'
    try {
      outcome = await this.deliverQueued(sessionId, item.clientMessageId, item.content, item.attachments)
    } catch (error) {
      this.reportError(sessionId, error)
      outcome = 'rejected'
    }
    if (outcome === 'started') await this.applyQueue(sessionId, { kind: 'markSent', messageId: item.messageId })
    else await this.applyQueue(sessionId, { kind: 'markFailed', messageId: item.messageId, error: outcome === 'unknown' ? { code: 'queue_dispatch_unknown', message: 'The dispatch ended without a known outcome.' } : { code: 'queue_dispatch_failed', message: 'The Runtime did not accept the message.' } })
  }

  private async deliverQueued(sessionId: string, clientMessageId: string, content: string, attachments: readonly QueueAttachment[]): Promise<'started' | 'rejected' | 'unknown'> {
    const binding = await this.binding(sessionId)
    const refs = this.deps.attachments === undefined ? [] : await Promise.all(attachments.map(a => this.deps.attachments!(sessionId, { fileId: a.fileId, name: a.name ?? a.fileId, mediaType: a.mediaType ?? 'application/octet-stream', size: a.size ?? 0 })))
    let acceptance
    try {
      acceptance = await binding.session.prompt({ text: content, ...(refs.length > 0 ? { attachments: refs } : {}) }, { deliveryId: clientMessageId, clientMessageId })
    } catch (error) {
      acceptance = { outcome: 'unknown' as const, error: { code: 'delivery_outcome_unknown', message: (error as Error).message } }
    }
    if (acceptance.outcome === 'accepted') {
      await this.writeUserMessage(sessionId, clientMessageId, content, acceptance.userItemId ?? null)
      if (acceptance.turnId !== undefined) await this.onTurnStarted(sessionId, acceptance.turnId, clientMessageId)
      return 'started'
    }
    await this.writeFailedUserMessage(sessionId, clientMessageId, content, acceptance.error.code, acceptance.error.message)
    return acceptance.outcome === 'rejected' ? 'rejected' : 'unknown'
  }

  private async applyQueue(sessionId: string, op: QueueOp): Promise<SessionQueue> {
    const before = await this.deps.store.queues.get(sessionId)
    const after = await this.deps.store.queues.apply(sessionId, op, this.deps.clock.nowIso())
    if (after.revision !== before.revision) this.deps.live.emit('runtime.queue.updated', { sessionId, queue: queueRules.queueState(after) })
    return after
  }

  // ---------------------------------------------------------------- planning & goals

  private async planningOf(sessionId: string): Promise<PlanningState> {
    const session = await this.requireSession(sessionId)
    return (await this.deps.store.planning.load(sessionId)) ?? initialPlanning(sessionId, session.runtimeType, this.deps.ids.newId('ep_'))
  }

  /** `session.planning`: mode switches and review actions; approval must name the current plan version. */
  public async planning(sessionId: string, request: { command: string; operationId: string; reviewId?: string | null; planId?: string | null; planRevision?: number | null; contentHash?: string | null; expectedRevision?: number | null; epoch?: string | null; feedback?: string | null }): Promise<Record<string, unknown>> {
    return this.serial(sessionId, async () => {
      let state = await this.planningOf(sessionId)
      const binding = await this.binding(sessionId)
      switch (request.command) {
        case 'enter_plan':
        case 'exit_plan': {
          if (binding.session.planning === undefined) throw new UseCaseError('runtime_capability_unsupported', 'This Runtime has no planning mode.')
          const mode = request.command === 'enter_plan' ? 'plan' : 'normal'
          await binding.session.planning.setMode(mode)
          state = observeMode(state, mode)
          break
        }
        case 'approve_and_execute':
        case 'request_revision':
        case 'dismiss_review': {
          const review = requireReview(state, request)
          const action = request.command === 'approve_and_execute' ? 'approve' : request.command === 'request_revision' ? 'revise' : 'dismiss'
          const noticeId = state.nativeReview?.noticeId
          if (noticeId !== undefined) {
            await binding.session.respond(noticeId, { kind: 'plan_review', action, ...(request.feedback ? { feedback: request.feedback } : {}), planContentHash: review.contentHash })
          }
          state = setReviewStatus(state, action === 'approve' ? 'approved' : action === 'revise' ? 'revision_requested' : 'dismissed')
          break
        }
        default:
          throw new UseCaseError('invalid_argument', `unknown planning command ${request.command}`)
      }
      const commit = await this.deps.store.planning.save(state, null)
      this.publish(commit)
      return { operationId: request.operationId, revision: state.revision }
    })
  }

  public async onPlanUpdated(sessionId: string, event: Extract<RuntimeEvent, { type: 'plan.updated' }>): Promise<void> {
    if (event.document === undefined) return
    const state = await this.planningOf(sessionId)
    const result = finalizePlan(state, {
      nativeId: event.planId,
      text: event.document.markdown,
      turnId: event.turnId ?? null,
      at: this.deps.clock.nowIso(),
      nativeReview: null,
      reviewActions: null,
    })
    if (!result.changed) return
    this.publish(await this.deps.store.planning.save(result.state, result.document))
    this.deps.live.emit('runtime.status', { sessionId, event: 'planning.state.updated', revision: result.state.revision })
  }

  public async onPlanningMode(sessionId: string, mode: 'plan' | 'normal'): Promise<void> {
    const state = await this.planningOf(sessionId)
    const next = observeMode(state, mode)
    if (next !== state) this.publish(await this.deps.store.planning.save(next, null))
  }

  public async goal(sessionId: string, request: GoalRequest): Promise<Record<string, unknown>> {
    return this.serial(sessionId, async () => {
      const session = await this.requireSession(sessionId)
      const state = (await this.deps.store.goals.load(sessionId)) ?? initialGoalState({ sessionId, runtime: session.runtimeType, runtimeId: session.runtimeId, sourceEpoch: this.deps.ids.newId('ep_') })
      checkGoalRequest(state, request)
      const binding = await this.binding(sessionId)
      const port = binding.session.goal
      if (port === undefined) throw new UseCaseError('runtime_capability_unsupported', 'This Runtime has no session goal.')
      switch (request.action) {
        case 'set':
        case 'edit':
          await port.set(request.objective ?? '')
          break
        case 'pause':
          await port.pause()
          break
        case 'resume':
          await port.resume()
          break
        case 'clear':
          await port.clear()
          break
      }
      const observed = await port.get()
      await this.onGoalUpdated(sessionId, observed as unknown as Record<string, unknown> | null)
      const saved = await this.deps.store.goals.load(sessionId)
      return { operationId: request.operationId, revision: saved?.revision ?? state.revision }
    })
  }

  public async onGoalUpdated(sessionId: string, wire: Record<string, unknown> | null): Promise<void> {
    const session = await this.requireSession(sessionId)
    const state = (await this.deps.store.goals.load(sessionId)) ?? initialGoalState({ sessionId, runtime: session.runtimeType, runtimeId: session.runtimeId, sourceEpoch: this.deps.ids.newId('ep_') })
    const native = (wire?.goal ?? null) as Record<string, unknown> | null
    const next = observeGoal(state, {
      goal: native === null ? null : {
        objective: String(native.objective ?? ''),
        status: (native.status ?? 'active') as never,
        ...(typeof native.id === 'string' ? { nativeIdentity: native.id } : {}),
        ...(typeof native.updatedAt === 'string' ? { updatedAt: native.updatedAt } : {}),
        ...(typeof native.createdAt === 'string' ? { createdAt: native.createdAt } : {}),
      },
      empty: native === null,
    }, { newId: () => this.deps.ids.newId('goal_'), now: this.deps.clock.nowIso() })
    if (next.revision !== state.revision || JSON.stringify(next) !== JSON.stringify(state)) {
      this.publish(await this.deps.store.goals.save(next))
      this.deps.live.emit('runtime.status', { sessionId, event: 'goal.state.updated', revision: next.revision })
    }
  }

  // ---------------------------------------------------------------- runtime events

  public async onTurnStarted(sessionId: string, turnId: string, clientMessageId: string | null): Promise<void> {
    const session = await this.requireSession(sessionId)
    if (session.activeTurn?.turnId === turnId && session.status === 'running') return
    await this.patchSession(sessionId, { status: 'running', activeTurn: { turnId, clientMessageId, startedAt: this.deps.clock.nowIso() } })
    if (clientMessageId !== null) await this.settleDeliveryStarted(sessionId, clientMessageId, null)
  }

  public async onTurnEnded(sessionId: string, _turnId: string, outcome: 'completed' | 'interrupted' | 'failed', _message: string | null): Promise<void> {
    const after = statusAfterTurn(outcome)
    const at = this.deps.clock.nowIso()
    const closed = await this.deps.store.interactions.expireBlocking(sessionId, 'turn_ended', at)
    for (const interaction of closed) this.deps.live.emit('runtime.notice.updated', { sessionId, notice: { ...interaction.payload, noticeId: interaction.noticeId, status: 'expired' } })
    await this.patchSession(sessionId, { status: after.status, activeTurn: null, turnEnded: true, lastActivityAt: at })
    await this.applyQueue(sessionId, { kind: 'turnEnded', outcome: after.queueOutcome })
    void this.serial(sessionId, () => this.dispatchNext(sessionId)).catch(error => this.reportError(sessionId, error))
  }

  public async onInteractionOpened(sessionId: string, event: Extract<RuntimeEvent, { type: 'interaction.opened' }>): Promise<void> {
    const at = this.deps.clock.nowIso()
    const notice: Record<string, unknown> = {
      noticeId: event.interactionId,
      sessionId,
      type: 'interaction',
      interactionType: event.kind === 'approval' ? 'approval' : event.kind === 'plan_review' ? 'confirmation' : 'input_request',
      title: event.title,
      ...(event.body !== undefined ? { message: event.body } : {}),
      status: 'open',
      responseRequired: true,
      createdAt: at,
      actions: (event.options ?? []).map(option => ({ actionId: option.id, label: option.label, style: option.kind.startsWith('reject') ? 'danger' : 'primary' })),
      ...(event.schema !== undefined ? { metadata: { schema: event.schema } } : {}),
      ...(event.itemId !== undefined ? { source: { timelineItemId: event.itemId } } : {}),
      blocking: { scope: 'session', targetId: sessionId },
    }
    const interaction = interactionRules.open({ sessionId, noticeId: event.interactionId, kind: event.kind === 'approval' ? 'approval' : event.kind === 'plan_review' ? 'confirmation' : 'input_request', blocking: true, payload: notice, at })
    await this.deps.store.interactions.save(interaction)
    if (event.kind === 'plan_review' && event.plan !== undefined) {
      const state = await this.planningOf(sessionId)
      const result = finalizePlan(state, { nativeId: event.plan.planId, text: event.plan.markdown, turnId: event.turnId ?? null, at, nativeReview: { noticeId: event.interactionId }, reviewActions: ['approve_and_execute', 'request_revision', 'dismiss_review'] })
      this.publish(await this.deps.store.planning.save(result.state, result.document))
    }
    if (event.kind === 'approval') await this.patchSession(sessionId, { status: 'waiting_approval' })
    this.deps.live.emit('runtime.notice.updated', { sessionId, notice })
  }

  public async onInteractionResolved(sessionId: string, interactionId: string, resolution: 'answered' | 'withdrawn' | 'expired'): Promise<void> {
    const current = await this.deps.store.interactions.get(sessionId, interactionId)
    if (current === null) return
    const at = this.deps.clock.nowIso()
    const next = resolution === 'answered' ? interactionRules.resolve(current, resolution, at) : interactionRules.expire(current, resolution, at)
    await this.deps.store.interactions.save(next)
    const session = await this.requireSession(sessionId)
    if (session.status === 'waiting_approval' && (await this.deps.store.interactions.list(sessionId, true)).length === 0) await this.patchSession(sessionId, { status: 'running' })
    this.deps.live.emit('runtime.notice.updated', { sessionId, notice: { ...next.payload, noticeId: interactionId, status: next.state === 'resolved' ? 'resolved' : 'expired' } })
  }

  public onLiveFact(sessionId: string, event: RuntimeEvent): void {
    this.deps.live.emit('runtime.status', { sessionId, event: event.type, fact: event as unknown as Record<string, unknown> })
  }

  /** The Runtime session ended under us: the running turn fails with an unknown outcome; nothing is resent. */
  public async onSessionLost(sessionId: string, error: { code: string; message: string }): Promise<void> {
    const binding = this.bindings.get(sessionId)
    this.bindings.delete(sessionId)
    if (binding !== undefined) await binding.flushNow().catch(() => undefined)
    const session = await this.deps.store.sessions.get(sessionId)
    if (session === null) return
    const at = this.deps.clock.nowIso()
    await this.deps.store.interactions.expireBlocking(sessionId, error.code, at)
    if (session.activeTurn !== null) {
      const projector = binding?.projector ?? new TimelineProjector(session.runtimeType, session.externalSessionId, await this.deps.store.timeline.latest(sessionId), () => at)
      const settled = projector.settleOpen('failed')
      const card = projector.platform({
        id: `aa_turn_failed_${session.activeTurn.turnId}`,
        type: 'system',
        status: 'failed',
        role: 'system',
        content: { kind: 'error', text: 'The Runtime stopped during this turn; its outcome is unknown.', error },
        source: { runtime: 'platform', event: 'session.lost' },
        createdAt: at,
        completedAt: at,
      })
      await this.commit(sessionId, { upserts: [...settled, card], session: { status: 'error', activeTurn: null, turnEnded: true } })
      await this.applyQueue(sessionId, { kind: 'turnEnded', outcome: 'error' })
    } else if (session.status !== 'idle') {
      await this.patchSession(sessionId, { status: 'idle' })
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * After a restart: deliveries left in `sending` settle as started (evidence) or unknown; queue items left in
   * `sending` fail with `queue_dispatch_unknown`; open interactions are shown as expired; turns that were
   * running are closed as failed. Nothing is resent.
   */
  public async recover(): Promise<void> {
    const at = this.deps.clock.nowIso()
    for (const delivery of await this.deps.store.deliveries.inFlight()) {
      const evidence = await this.deps.store.timeline.findByClientMessageId(delivery.sessionId, delivery.clientMessageId)
      await this.deps.store.deliveries.transition(delivery.sessionId, delivery.clientMessageId, evidence !== null ? 'started' : 'unknown', { at, ...(evidence === null ? { errorCode: 'delivery_outcome_unknown' } : {}) })
    }
    for (const queue of await this.deps.store.queues.nonEmpty()) {
      for (const item of queue.items) {
        if (item.status !== 'sending') continue
        const evidence = await this.deps.store.timeline.findByClientMessageId(queue.sessionId, item.clientMessageId)
        await this.applyQueue(queue.sessionId, evidence !== null ? { kind: 'markSent', messageId: item.messageId } : { kind: 'markFailed', messageId: item.messageId, error: { code: 'queue_dispatch_unknown', message: 'The Connector restarted during the dispatch.' } })
      }
    }
    for (const interaction of await this.deps.store.interactions.allActive()) {
      await this.deps.store.interactions.save(interactionRules.expire(interaction, 'connector_restarted', at))
    }
    for (const session of await this.deps.store.sessions.list()) {
      if (session.activeTurn !== null) await this.onSessionLost(session.sessionId, { code: 'connector_restarted', message: 'The Connector restarted during this turn.' })
    }
  }

  public async close(): Promise<void> {
    await Promise.all([...this.bindings.values()].map(binding => binding.close()))
    this.bindings.clear()
  }

  /** For tests and diagnostics. */
  public isBound(sessionId: string): boolean {
    return this.bindings.has(sessionId)
  }
}
