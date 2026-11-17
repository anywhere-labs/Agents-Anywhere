import { checkRequest as checkGoalRequest, goalWire, initialGoalState, observe as observeGoal, type GoalRequest, type GoalState } from '../../domain/goals/index.js'
import { UseCaseError } from '../errors.js'
import type { CommandReceipt } from '../ports/index.js'
import type { RuntimeBindings } from '../session/bindings.js'
import type { SessionKernel } from '../session/kernel.js'
import { withResult } from '../session/receipts.js'

/** The session goal (runtime-workflows 1.2 goal): the Runtime's native goal, mirrored with a revision. */
export class GoalService {
  public constructor(private readonly kernel: SessionKernel, private readonly bindings: RuntimeBindings) {}

  public async goal(sessionId: string, request: GoalRequest, receipt?: CommandReceipt | null): Promise<Record<string, unknown>> {
    const kernel = this.kernel
    return kernel.serial(sessionId, async () => {
      const session = await kernel.requireSession(sessionId)
      const binding = await this.bindings.binding(sessionId)
      const port = binding.session.goal
      if (port === undefined) throw new UseCaseError('runtime_capability_unsupported', 'This Runtime has no session goal.')
      let state = await kernel.deps.store.goals.load(sessionId)
      if (state === null || state.freshness !== 'fresh') {
        // Nothing observed yet (a client acted on the capabilities alone): the native goal first, so the
        // request is checked against what the Runtime really has.
        await this.onGoalUpdated(sessionId, (await port.get()) as unknown as Record<string, unknown> | null)
        state = await kernel.deps.store.goals.load(sessionId)
      }
      state ??= initialGoalState({ sessionId, runtime: session.runtimeType, runtimeId: session.runtimeId, sourceEpoch: kernel.deps.ids.newId('ep_') })
      checkGoalRequest(state, request)
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
      // The goal state the Runtime reported commits with the receipt (when it changed; otherwise nothing local did).
      // A v2 `GoalResponse` (`CommandAck.r`), the body the secure channel returns as is.
      const resultOf = (saved: GoalState) => ({ operationId: request.operationId, outcome: 'applied', ok: true, state: goalWire(saved, session.takeover) })
      await this.onGoalUpdated(sessionId, observed as unknown as Record<string, unknown> | null, saved => withResult(receipt, resultOf(saved)))
      return resultOf((await kernel.deps.store.goals.load(sessionId)) ?? state)
    })
  }

  /**
   * `/goal` on a new session: the first message becomes the goal's objective and
   * is not sent as a prompt; the Runtime works toward the goal on its own.
   */
  public async deliverGoal(sessionId: string, clientMessageId: string, objective: string): Promise<void> {
    const deps = this.kernel.deps
    const binding = await this.bindings.binding(sessionId)
    const port = binding.session.goal
    if (port === undefined) throw new UseCaseError('goal_unavailable', 'This Runtime has no session goal.')
    await deps.store.deliveries.transition(sessionId, clientMessageId, 'sending', { at: deps.clock.nowIso() })
    await port.set(objective.trim())
    await deps.store.deliveries.transition(sessionId, clientMessageId, 'started', { at: deps.clock.nowIso() })
    await this.onGoalUpdated(sessionId, (await port.get()) as unknown as Record<string, unknown> | null)
  }

  public async onGoalUpdated(sessionId: string, wire: Record<string, unknown> | null, receiptFor?: (state: GoalState) => CommandReceipt | null): Promise<void> {
    const deps = this.kernel.deps
    const session = await this.kernel.requireSession(sessionId)
    const state = (await deps.store.goals.load(sessionId)) ?? initialGoalState({ sessionId, runtime: session.runtimeType, runtimeId: session.runtimeId, sourceEpoch: deps.ids.newId('ep_') })
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
    }, { newId: () => deps.ids.newId('goal_'), now: deps.clock.nowIso() })
    if (next.revision !== state.revision || JSON.stringify(next) !== JSON.stringify(state)) {
      this.kernel.publish(await deps.store.goals.save(next, receiptFor?.(next) ?? null))
      this.emitGoal(sessionId, next, session.takeover)
    }
  }

  /**
   * `goal.state.updated` on `runtime.status` (device-meshcall 1.0 `RuntimeStatusEvent`): the v2 event name and the
   * client-shaped state, both inside `status`.
   */
  private emitGoal(sessionId: string, state: GoalState, takeover: boolean): void {
    this.kernel.emitSessionStatus(sessionId, { event: 'goal.state.updated', revision: state.revision, state: goalWire(state, takeover) })
  }
}
