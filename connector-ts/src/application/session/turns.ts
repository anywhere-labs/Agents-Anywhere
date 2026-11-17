import { statusAfterTurn } from '../../domain/conversation/index.js'
import type { QueueOp, RuntimeEvent } from '../ports/index.js'
import { TimelineProjector } from '../projection.js'
import type { RuntimeBindings } from './bindings.js'
import type { DeliveryRecords } from './deliveries.js'
import type { SessionKernel } from './kernel.js'

/** What a turn's end does to the session queue (the queue context implements it). */
export interface TurnQueue {
  /** Applies a queue operation and tells subscribers when the queue changed. */
  apply(sessionId: string, op: QueueOp): Promise<unknown>
  /** Dispatches the head of the queue when the session is idle. */
  dispatchNext(sessionId: string): Promise<void>
}

/** A session's turns as the Runtime reports them: started, ended, or lost with the Runtime session. */
export class TurnLifecycle {
  /**
   * The last turn that ended, per session. A prompt's acceptance can be handled after the Runtime already
   * reported the whole turn (a fast reply); its start report must not reopen that turn.
   */
  private readonly ended = new Map<string, string>()

  public constructor(
    private readonly kernel: SessionKernel,
    private readonly bindings: RuntimeBindings,
    private readonly deliveries: DeliveryRecords,
    private readonly queue: TurnQueue,
  ) {}

  public async onTurnStarted(sessionId: string, turnId: string, clientMessageId: string | null): Promise<void> {
    const session = await this.kernel.requireSession(sessionId)
    if (session.activeTurn?.turnId === turnId && session.status === 'running') return
    // Checked right before the patch is issued: an end recorded later queues its own patch after this one.
    if (this.ended.get(sessionId) === turnId) {
      if (clientMessageId !== null) await this.deliveries.settleDeliveryStarted(sessionId, clientMessageId, null)
      return
    }
    await this.kernel.patchSession(sessionId, { status: 'running', activeTurn: { turnId, clientMessageId, startedAt: this.kernel.deps.clock.nowIso() } })
    if (clientMessageId !== null) await this.deliveries.settleDeliveryStarted(sessionId, clientMessageId, null)
  }

  public async onTurnEnded(sessionId: string, turnId: string, outcome: 'completed' | 'interrupted' | 'failed', _message: string | null): Promise<void> {
    this.ended.set(sessionId, turnId)
    const deps = this.kernel.deps
    const after = statusAfterTurn(outcome)
    const at = deps.clock.nowIso()
    const closed = await deps.store.interactions.expireBlocking(sessionId, 'turn_ended', at)
    for (const interaction of closed) deps.live.emit('runtime.notice.updated', { sessionId, notice: { ...interaction.payload, noticeId: interaction.noticeId, status: 'expired' } })
    await this.kernel.patchSession(sessionId, { status: after.status, activeTurn: null, turnEnded: true, lastActivityAt: at })
    await this.queue.apply(sessionId, { kind: 'turnEnded', outcome: after.queueOutcome })
    void this.kernel.serial(sessionId, () => this.queue.dispatchNext(sessionId)).catch(error => this.kernel.reportError(sessionId, error))
  }

  public onLiveFact(sessionId: string, event: RuntimeEvent): void {
    this.kernel.emitSessionStatus(sessionId, { event: event.type, fact: event as unknown as Record<string, unknown> })
  }

  /** The Runtime session ended under us: the running turn fails with an unknown outcome; nothing is resent. */
  public async onSessionLost(sessionId: string, error: { code: string; message: string }): Promise<void> {
    const deps = this.kernel.deps
    const binding = this.bindings.take(sessionId)
    if (binding !== undefined) await binding.flushNow().catch(() => undefined)
    const session = await deps.store.sessions.get(sessionId)
    if (session === null) return
    const at = deps.clock.nowIso()
    await deps.store.interactions.expireBlocking(sessionId, error.code, at)
    if (session.activeTurn !== null) {
      const projector = binding?.projector ?? new TimelineProjector(session.runtimeType, session.externalSessionId, await deps.store.timeline.latest(sessionId), () => at)
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
      await this.kernel.commit(sessionId, { upserts: [...settled, card], session: { status: 'error', activeTurn: null, turnEnded: true } })
      await this.queue.apply(sessionId, { kind: 'turnEnded', outcome: 'error' })
    } else if (session.status !== 'idle') {
      await this.kernel.patchSession(sessionId, { status: 'idle' })
    }
  }
}
