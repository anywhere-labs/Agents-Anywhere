import { ConversationError, admitMessage, queue as queueRules, type QueueAttachment, type QueueMode, type SessionOrigin } from '../../domain/conversation/index.js'
import { UseCaseError } from '../errors.js'
import type { GoalService } from '../goals/goal-service.js'
import type { PlanningService } from '../planning/planning-service.js'
import type { PromptAttachment } from '../ports/index.js'
import type { QueueService } from '../queue/queue-service.js'
import type { CreationIntent, OpenSpec, RuntimeBindings } from '../session/bindings.js'
import { attachmentInfo, type DeliveryRecords } from '../session/deliveries.js'
import type { AttachmentRef, SessionKernel } from '../session/kernel.js'
import { digestOf, withResult, type CommandContext } from '../session/receipts.js'
import type { TurnLifecycle } from '../session/turns.js'

export interface SendMessageCommand {
  sessionId: string
  clientMessageId: string
  content: string
  attachments?: AttachmentRef[]
  queue?: QueueMode | null
}

export interface CreateSessionCommand {
  sessionId: string
  runtimeId: string
  runtimeType: string
  cwd: string
  /** The Server project, when a client creates the session through a secure channel. */
  projectId?: string | null
  /** An Agent creates this session (collaboration tools). */
  origin?: SessionOrigin | null
  title?: string | null
  selections?: Record<string, string | null>
  clientMessageId: string
  content: string
  attachments?: AttachmentRef[]
  takeover?: boolean
  /** `/plan`: the first message runs in plan mode; the mode is switched on before it is sent. */
  planningIntent?: CreationIntent | null
  /** `/goal`: the first message is the session goal's objective, not a prompt. */
  goalIntent?: CreationIntent | null
  /** runtime-workflows 1.2 `configuration`: Agent options set before the first message. */
  configuration?: Record<string, string | boolean>
}

export type SendResult =
  | { delivery: 'accepted'; clientMessageId: string }
  | { delivery: 'queued'; clientMessageId: string; item: Record<string, unknown>; queuePosition: number; queue: Record<string, unknown> }
  | { delivery: 'duplicate'; clientMessageId: string; state: string }

/**
 * Sending a message, and creating a session with its first message: a delivery is accepted once it is on disk (with
 * the command's receipt), queued when the session is busy, and handed to the Runtime after the ack.
 */
export class MessageService {
  public constructor(
    private readonly kernel: SessionKernel,
    private readonly bindings: RuntimeBindings,
    private readonly deliveries: DeliveryRecords,
    private readonly turns: TurnLifecycle,
    private readonly queue: QueueService,
    private readonly planning: PlanningService,
    private readonly goals: GoalService,
  ) {}

  /** Create-and-start, or a prepared creation: the session id is given; the device creates the Conversation and sends the first message. */
  public async createSession(command: CreateSessionCommand, context: CommandContext): Promise<SendResult> {
    if (command.planningIntent != null && command.goalIntent != null) throw new UseCaseError('invalid_argument', 'A new session takes a planning intent or a goal intent, not both.')
    if (command.goalIntent != null && command.content.trim() === '') throw new UseCaseError('invalid_argument', 'The goal of a new session cannot be empty.')
    const open: OpenSpec = {
      cwd: command.cwd,
      ...(command.title != null ? { title: command.title } : {}),
      ...(command.selections !== undefined ? { selections: command.selections } : {}),
      ...(command.planningIntent != null ? { planningIntent: command.planningIntent } : {}),
      ...(command.goalIntent != null ? { goalIntent: command.goalIntent } : {}),
      ...(command.configuration !== undefined && Object.keys(command.configuration).length > 0 ? { configuration: command.configuration } : {}),
    }
    const deps = this.kernel.deps
    return this.kernel.serial(command.sessionId, async () => {
      const at = deps.clock.nowIso()
      await deps.store.sessions.create({
        sessionId: command.sessionId,
        runtimeType: command.runtimeType,
        runtimeId: command.runtimeId,
        externalSessionId: null,
        cwd: command.cwd,
        projectId: command.projectId ?? null,
        origin: command.origin ?? null,
        nativeTitle: command.title ?? null,
        status: 'pending',
        sourceAvailability: 'available',
        takeover: command.takeover ?? true,
        at,
      })
      const received = await deps.store.deliveries.receive({
        sessionId: command.sessionId,
        clientMessageId: command.clientMessageId,
        inputDigest: context.inputDigest ?? digestOf({ content: command.content, attachments: command.attachments ?? [] }),
        userItem: null,
        enqueue: null,
        pending: {
          content: command.content,
          attachments: (command.attachments ?? []) as unknown as Record<string, unknown>[],
          open,
        },
        commandId: context.commandId,
        receipt: withResult(context.receipt, {
          sessionId: command.sessionId, delivery: 'accepted', clientMessageId: command.clientMessageId,
          ...(command.attachments?.length ? { attachments: command.attachments } : {}),
        }),
        at,
      })
      if (received.duplicate) return { delivery: 'duplicate', clientMessageId: command.clientMessageId, state: received.delivery.state }
      const created = { sessionId: command.sessionId, runtimeType: command.runtimeType, runtimeId: command.runtimeId }
      this.kernel.countUsage(created, 'session.created')
      this.kernel.countUsage(created, 'message.sent')
      this.handOff(command.sessionId, command.clientMessageId, command.content, command.attachments ?? [], open)
      return { delivery: 'accepted', clientMessageId: command.clientMessageId }
    })
  }

  /** `session.sendMessage`: accepted once the delivery is on disk; the Runtime hand-off happens after the ack. */
  public async sendMessage(command: SendMessageCommand, context: CommandContext): Promise<SendResult> {
    const kernel = this.kernel
    const deps = kernel.deps
    return kernel.serial(command.sessionId, async () => {
      const session = await kernel.requireSession(command.sessionId)
      if (session.archived) throw new UseCaseError('session_archived', 'the session is archived')
      const existing = await deps.store.deliveries.get(command.sessionId, command.clientMessageId)
      const inputDigest = context.inputDigest ?? digestOf({ content: command.content, attachments: command.attachments ?? [] })
      if (existing !== null) {
        if (existing.inputDigest !== inputDigest) throw new ConversationError('delivery_conflict', `clientMessageId ${command.clientMessageId} was already used for a different message`)
        return { delivery: 'duplicate', clientMessageId: command.clientMessageId, state: existing.state }
      }
      const queue = await deps.store.queues.get(command.sessionId)
      const admission = admitMessage({ status: session.status, queueLength: queue.items.length, queue: command.queue ?? null, queueAvailable: session.takeover && !session.archived })
      if (admission.kind === 'reject') {
        throw new UseCaseError('session_busy', admission.legacy ? `session is ${admission.status}` : 'The session is busy.', { legacy: admission.legacy, status: admission.status })
      }
      const at = deps.clock.nowIso()
      const attachments: QueueAttachment[] = (command.attachments ?? []).map(ref => ({
        fileId: ref.fileId,
        name: ref.name,
        mediaType: ref.mediaType,
        size: ref.size,
        ...(ref.sha256 != null ? { sha256: ref.sha256 } : {}),
        ...(ref.sealedKey != null ? { sealedKey: ref.sealedKey } : {}),
      }))
      const received = await deps.store.deliveries.receive({
        sessionId: command.sessionId,
        clientMessageId: command.clientMessageId,
        inputDigest,
        userItem: null,
        enqueue: admission.kind === 'enqueue'
          ? {
            mode: admission.interrupt ? 'interrupt' : 'auto',
            item: { messageId: deps.ids.newId('qmsg_'), sessionId: command.sessionId, clientMessageId: command.clientMessageId, content: command.content, attachments, createdBy: context.actor, createdAt: at, updatedAt: at },
          }
          : null,
        pending: admission.kind === 'enqueue' ? null : { content: command.content, attachments: (command.attachments ?? []) as unknown as Record<string, unknown>[] },
        commandId: context.commandId,
        // A queued message's ack body is the queue after it, which the store fills in.
        receipt: withResult(context.receipt, admission.kind === 'enqueue' ? null : { delivery: 'accepted', clientMessageId: command.clientMessageId }),
        at,
      })
      kernel.countUsage(session, 'message.sent')
      if (received.queue !== null && received.queueItem !== null) {
        deps.live.emit('runtime.queue.updated', { sessionId: command.sessionId, queue: queueRules.queueState(received.queue) })
        if (admission.kind === 'enqueue' && admission.interrupt) void kernel.serial(command.sessionId, () => this.queue.interruptForQueue(command.sessionId))
        return queueRules.queuedDelivery(received.queue, received.queueItem.messageId, command.clientMessageId)
      }
      this.handOff(command.sessionId, command.clientMessageId, command.content, command.attachments ?? [])
      return { delivery: 'accepted', clientMessageId: command.clientMessageId }
    })
  }

  /**
   * `/plan <task>` on an open session (`session.planning` `submit_task`): plan mode first, then the task as a message.
   * A busy session or a failed mode switch rejects it before anything is sent, so the client keeps the draft. The
   * operation id is the delivery's `clientMessageId`: a retry of the same operation never sends the task twice.
   */
  public async submitPlanTask(command: SendMessageCommand, context: CommandContext): Promise<Record<string, unknown>> {
    if (command.content.trim() === '') throw new UseCaseError('invalid_argument', 'The task to plan cannot be empty.')
    const deps = this.kernel.deps
    const existing = await deps.store.deliveries.get(command.sessionId, command.clientMessageId)
    if (existing === null) {
      const session = await this.kernel.requireSession(command.sessionId)
      if (session.archived) throw new UseCaseError('session_archived', 'the session is archived')
      const queue = await deps.store.queues.get(command.sessionId)
      const admission = admitMessage({ status: session.status, queueLength: queue.items.length, queue: null, queueAvailable: false })
      if (admission.kind === 'reject') throw new UseCaseError('session_busy', 'The session is busy.', { legacy: admission.legacy, status: admission.status })
      await this.planning.enterPlanForTask(command.sessionId)
    }
    // The planning command's receipt holds its `PlanningResponse`; the delivery record makes a replay a duplicate.
    await this.sendMessage({ ...command, queue: null }, { ...context, inputDigest: null, receipt: null })
    return { operationId: command.clientMessageId, outcome: 'applied', ok: true, execution: 'accepted', state: await this.planning.wireState(command.sessionId) }
  }

  /**
   * The Runtime hand-off of an accepted delivery, after the ack (and again after a restart, from what the
   * delivery kept). `open` creates the Runtime session first (a new session's first message).
   */
  public handOff(sessionId: string, clientMessageId: string, content: string, refs: AttachmentRef[], open?: OpenSpec): void {
    void this.kernel.serial(sessionId, async () => {
      try {
        if (open !== undefined) await this.bindings.openNew(sessionId, open)
        if (open?.goalIntent !== undefined) {
          await this.goals.deliverGoal(sessionId, clientMessageId, content)
          return
        }
        if (open?.planningIntent !== undefined) await this.planning.enterPlanForCreation(sessionId)
        await this.deliver(sessionId, clientMessageId, content, refs)
      } catch (error) {
        await this.failDelivery(sessionId, clientMessageId, content, refs, error)
      }
    })
  }

  /** Hands an accepted delivery to the Runtime. Never retried on an unknown outcome. */
  private async deliver(sessionId: string, clientMessageId: string, content: string, refs: AttachmentRef[]): Promise<'started' | 'rejected' | 'unknown'> {
    const deps = this.kernel.deps
    const binding = await this.bindings.binding(sessionId)
    // Attachments first: one that cannot be fetched or opened (a sealed upload with a wrong key) is a rejection
    // the Runtime never saw, not an unknown outcome.
    let attachments: PromptAttachment[]
    try {
      attachments = deps.attachments === undefined ? [] : await Promise.all(refs.map(ref => this.deliveries.resolveAttachment(sessionId, ref)))
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'attachment_unavailable'
      await deps.store.deliveries.transition(sessionId, clientMessageId, 'rejected', { at: deps.clock.nowIso(), errorCode: code })
      await this.deliveries.writeFailedUserMessage(sessionId, clientMessageId, content, code, (error as Error)?.message ?? code, refs.map(attachmentInfo))
      return 'rejected'
    }
    const at = deps.clock.nowIso()
    await deps.store.deliveries.transition(sessionId, clientMessageId, 'sending', { at })
    let acceptance
    try {
      acceptance = await binding.session.prompt({ text: content, ...(attachments.length > 0 ? { attachments } : {}) }, { deliveryId: clientMessageId, clientMessageId })
    } catch (error) {
      acceptance = { outcome: 'unknown' as const, error: { code: 'delivery_outcome_unknown', message: (error as Error).message } }
    }
    if (acceptance.outcome === 'accepted') {
      await this.deliveries.settleDeliveryStarted(sessionId, clientMessageId, acceptance.userItemId ?? null, content)
      await this.deliveries.writeUserMessage(sessionId, clientMessageId, content, acceptance.userItemId ?? null, refs.map(attachmentInfo))
      if (acceptance.turnId !== undefined) await this.turns.onTurnStarted(sessionId, acceptance.turnId, clientMessageId)
      return 'started'
    }
    const state = acceptance.outcome === 'rejected' ? 'rejected' : 'unknown'
    await deps.store.deliveries.transition(sessionId, clientMessageId, state, { at: deps.clock.nowIso(), errorCode: acceptance.error.code })
    await this.deliveries.writeFailedUserMessage(sessionId, clientMessageId, content, acceptance.error.code, acceptance.error.message, refs.map(attachmentInfo))
    return state
  }

  private async failDelivery(sessionId: string, clientMessageId: string, content: string, refs: readonly AttachmentRef[], error: unknown): Promise<void> {
    const deps = this.kernel.deps
    this.kernel.reportError(sessionId, error)
    const current = await deps.store.deliveries.get(sessionId, clientMessageId)
    if (current === null) return
    const code = error instanceof UseCaseError ? error.code : 'runtime_unavailable'
    if (current.state === 'accepted' || current.state === 'queued') {
      await deps.store.deliveries.transition(sessionId, clientMessageId, 'rejected', { at: deps.clock.nowIso(), errorCode: code })
    } else if (current.state === 'sending') {
      await deps.store.deliveries.transition(sessionId, clientMessageId, 'unknown', { at: deps.clock.nowIso(), errorCode: 'delivery_outcome_unknown' })
    } else {
      return
    }
    await this.deliveries.writeFailedUserMessage(sessionId, clientMessageId, content, code, (error as Error).message ?? String(error), refs.map(attachmentInfo))
  }
}
