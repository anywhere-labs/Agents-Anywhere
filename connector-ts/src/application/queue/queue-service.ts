import { queue as queueRules, type QueueAttachment, type SessionQueue } from '../../domain/conversation/index.js'
import { UseCaseError } from '../errors.js'
import type { CommandReceipt, PromptAttachment, QueueOp } from '../ports/index.js'
import type { RuntimeBindings } from '../session/bindings.js'
import { attachmentInfo, type DeliveryRecords } from '../session/deliveries.js'
import type { SessionKernel } from '../session/kernel.js'
import { withResult } from '../session/receipts.js'
import type { TurnLifecycle, TurnQueue } from '../session/turns.js'

/** The queue operations a client may ask for (`session.queue.*`); the rest are the engine's own. */
export type ClientQueueOp = Exclude<QueueOp, { kind: 'markSending' | 'markSent' | 'markFailed' | 'turnEnded' | 'dropForArchive' }>

/**
 * The session queue (04-connector.md §5.8): messages sent while a turn runs wait here and are dispatched one by one
 * when the session is idle. Single writer: no claim needed.
 */
export class QueueService implements TurnQueue {
  public constructor(
    private readonly kernel: SessionKernel,
    private readonly bindings: RuntimeBindings,
    private readonly deliveries: DeliveryRecords,
    private readonly turns: TurnLifecycle,
  ) {}

  /** Queue management (`session.queue.*`). */
  public async queueOp(sessionId: string, op: ClientQueueOp, receipt?: CommandReceipt | null): Promise<Record<string, unknown>> {
    const kernel = this.kernel
    return kernel.serial(sessionId, async () => {
      const session = await kernel.requireSession(sessionId)
      if (!session.takeover) throw new UseCaseError('session_not_taken_over', 'Take over the session before changing its queue.')
      const before = await kernel.deps.store.queues.get(sessionId)
      const after = await kernel.deps.store.queues.apply(sessionId, op, kernel.deps.clock.nowIso(), withResult(receipt, null))
      const state = queueRules.queueState(after)
      if (after.revision !== before.revision) kernel.deps.live.emit('runtime.queue.updated', { sessionId, queue: state })
      if (op.kind === 'sendNow') void kernel.serial(sessionId, () => this.interruptForQueue(sessionId))
      void kernel.serial(sessionId, () => this.dispatchNext(sessionId))
      return state as unknown as Record<string, unknown>
    })
  }

  /** Dispatches the head of the queue when the session is idle (single writer: no claim needed). */
  public async dispatchNext(sessionId: string): Promise<void> {
    const deps = this.kernel.deps
    const session = await deps.store.sessions.get(sessionId)
    if (session === null) return
    const queue = await deps.store.queues.get(sessionId)
    const decision = queueRules.nextDispatch(queue, session)
    if (decision.kind === 'interrupt') {
      await this.interruptForQueue(sessionId)
      return
    }
    if (decision.kind === 'wait') {
      if (decision.reason === 'archived') await this.apply(sessionId, { kind: 'dropForArchive' })
      return
    }
    const item = decision.item
    await this.apply(sessionId, { kind: 'markSending', messageId: item.messageId })
    let outcome: 'started' | 'rejected' | 'unknown'
    try {
      outcome = await this.deliverQueued(sessionId, item.clientMessageId, item.content, item.attachments)
    } catch (error) {
      this.kernel.reportError(sessionId, error)
      outcome = 'rejected'
    }
    if (outcome === 'started') await this.apply(sessionId, { kind: 'markSent', messageId: item.messageId })
    else await this.apply(sessionId, { kind: 'markFailed', messageId: item.messageId, error: outcome === 'unknown' ? { code: 'queue_dispatch_unknown', message: 'The dispatch ended without a known outcome.' } : { code: 'queue_dispatch_failed', message: 'The Runtime did not accept the message.' } })
  }

  private async deliverQueued(sessionId: string, clientMessageId: string, content: string, attachments: readonly QueueAttachment[]): Promise<'started' | 'rejected' | 'unknown'> {
    const binding = await this.bindings.binding(sessionId)
    let refs: PromptAttachment[]
    try {
      refs = this.kernel.deps.attachments === undefined ? [] : await Promise.all(attachments.map(a => this.deliveries.resolveAttachment(sessionId, {
        fileId: a.fileId,
        name: a.name ?? a.fileId,
        mediaType: a.mediaType ?? 'application/octet-stream',
        size: a.size ?? 0,
        ...(a.sha256 != null ? { sha256: a.sha256 } : {}),
        ...(a.sealedKey != null ? { sealedKey: a.sealedKey } : {}),
      })))
    } catch (error) {
      this.kernel.reportError(sessionId, error)
      return 'rejected'
    }
    let acceptance
    try {
      acceptance = await binding.session.prompt({ text: content, ...(refs.length > 0 ? { attachments: refs } : {}) }, { deliveryId: clientMessageId, clientMessageId })
    } catch (error) {
      acceptance = { outcome: 'unknown' as const, error: { code: 'delivery_outcome_unknown', message: (error as Error).message } }
    }
    if (acceptance.outcome === 'accepted') {
      await this.deliveries.writeUserMessage(sessionId, clientMessageId, content, acceptance.userItemId ?? null, attachments.map(attachmentInfo))
      if (acceptance.turnId !== undefined) await this.turns.onTurnStarted(sessionId, acceptance.turnId, clientMessageId)
      return 'started'
    }
    await this.deliveries.writeFailedUserMessage(sessionId, clientMessageId, content, acceptance.error.code, acceptance.error.message, attachments.map(attachmentInfo))
    return acceptance.outcome === 'rejected' ? 'rejected' : 'unknown'
  }

  /** Applies an engine-side queue operation and tells subscribers when the queue changed. */
  public async apply(sessionId: string, op: QueueOp): Promise<SessionQueue> {
    const deps = this.kernel.deps
    const before = await deps.store.queues.get(sessionId)
    const after = await deps.store.queues.apply(sessionId, op, deps.clock.nowIso())
    if (after.revision !== before.revision) deps.live.emit('runtime.queue.updated', { sessionId, queue: queueRules.queueState(after) })
    return after
  }

  /** Cancels the running turn so that the queue head goes next (`interrupt` mode, `sendNow`). */
  public async interruptForQueue(sessionId: string): Promise<void> {
    const session = await this.kernel.requireSession(sessionId)
    if (session.activeTurn === null || session.status === 'stopping') return
    const binding = this.bindings.get(sessionId)
    if (binding === undefined) return
    await binding.session.cancel(session.activeTurn.turnId)
  }
}
