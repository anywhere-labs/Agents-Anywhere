import { statusAfterTurn } from '../../domain/conversation/index.js'
import type { QueueOp } from '../ports/index.js'
import { TimelineProjector } from '../projection.js'
import type { LiveFact, RuntimeBindings } from './bindings.js'
import type { DeliveryRecords } from './deliveries.js'
import { elapsedMs, type SessionKernel } from './kernel.js'

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
    // The same end reported again is one turn.
    const repeated = this.ended.get(sessionId) === turnId
    this.ended.set(sessionId, turnId)
    const deps = this.kernel.deps
    const after = statusAfterTurn(outcome)
    const at = deps.clock.nowIso()
    const before = await deps.store.sessions.get(sessionId)
    const closed = await deps.store.interactions.expireBlocking(sessionId, 'turn_ended', at)
    for (const interaction of closed) this.kernel.emitNotice(interaction)
    await this.kernel.patchSession(sessionId, { status: after.status, activeTurn: null, turnEnded: true, lastActivityAt: at })
    if (before !== null) {
      for (const interaction of closed) this.kernel.countApprovalClosed(before, interaction)
      // Only sessions the platform drives count; a turn typed into the Agent locally is not platform usage.
      if (before.takeover && !repeated) {
        const startedAt = before.activeTurn?.startedAt ?? null
        this.kernel.countUsage(before, 'turn.ended', { outcome, durationMs: elapsedMs(startedAt, at) })
      }
      this.kernel.flushUsage()
    }
    await this.queue.apply(sessionId, { kind: 'turnEnded', outcome: after.queueOutcome })
    void this.kernel.serial(sessionId, () => this.queue.dispatchNext(sessionId)).catch(error => this.kernel.reportError(sessionId, error))
  }

  /** A Runtime live fact as its device-meshcall 1.0 `runtime.status` member. */
  public onLiveFact(sessionId: string, event: LiveFact): void {
    switch (event.type) {
      case 'config.updated':
        this.kernel.emitSessionStatus(sessionId, { event: event.type, options: event.options as unknown as Record<string, unknown>[] })
        return
      case 'commands.updated':
        this.kernel.emitSessionStatus(sessionId, {
          event: event.type,
          commands: event.commands.map(command => ({
            name: command.name,
            ...(command.description !== undefined ? { description: command.description } : {}),
            ...(command.inputHint !== undefined ? { inputHint: command.inputHint } : {}),
          })),
        })
        return
      case 'writer.changed':
        this.kernel.emitSessionStatus(sessionId, {
          event: event.type,
          writer: {
            holder: event.writer.holder,
            ...(event.writer.by !== undefined ? { by: event.writer.by } : {}),
            ...(event.writer.execution !== undefined ? { execution: event.writer.execution } : {}),
          },
        })
        return
      case 'usage.updated':
        this.kernel.emitSessionStatus(sessionId, {
          event: event.type,
          ...(event.usedTokens !== undefined ? { usedTokens: event.usedTokens } : {}),
          ...(event.contextWindow !== undefined ? { contextWindow: event.contextWindow } : {}),
          ...(event.cost !== undefined ? { cost: { amount: event.cost.amount, currency: event.cost.currency } } : {}),
        })
        return
      case 'background.updated':
        this.kernel.emitSessionStatus(sessionId, { event: event.type, task: { taskId: event.taskId, kind: event.kind, title: event.title, state: event.state } })
        return
      case 'capabilities.changed':
        this.kernel.emitSessionCapabilities(sessionId, event.capabilities)
        return
    }
  }

  /** The Runtime session ended under us: the running turn fails with an unknown outcome; nothing is resent. */
  public async onSessionLost(sessionId: string, error: { code: string; message: string }): Promise<void> {
    const deps = this.kernel.deps
    const binding = this.bindings.take(sessionId)
    if (binding !== undefined) await binding.flushNow().catch(() => undefined)
    const session = await deps.store.sessions.get(sessionId)
    if (session === null) return
    const at = deps.clock.nowIso()
    const closed = await deps.store.interactions.expireBlocking(sessionId, error.code, at)
    for (const interaction of closed) this.kernel.countApprovalClosed(session, interaction)
    if (session.activeTurn !== null) {
      if (session.takeover) this.kernel.countUsage(session, 'turn.ended', { outcome: 'failed', durationMs: elapsedMs(session.activeTurn.startedAt, at) })
      // A Connector restart is not the Runtime's error.
      if (error.code !== 'connector_restarted') this.kernel.countUsage(session, 'runtime.error')
      this.kernel.flushUsage()
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
