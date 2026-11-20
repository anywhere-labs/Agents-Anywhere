import { checkRequest as checkGoalRequest, goalWire, initialGoalState, observe as observeGoal, type GoalObservation, type GoalRequest, type GoalState } from '../../domain/goals/index.js'
import { UseCaseError } from '../errors.js'
import type { CommandReceipt, CommandRecord, ContractStatusOf } from '../ports/index.js'
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
        const current = await port.get()
        if (current !== null) state = await this.onGoalUpdated(sessionId, current)
      }
      state ??= initialGoalState({ sessionId, runtime: session.runtimeType, runtimeId: session.runtimeId, sourceEpoch: kernel.deps.ids.newId('ep_') })
      checkGoalRequest(state, request)
      if (receipt != null) {
        await kernel.deps.store.commands.settle({
          ...receipt, outcome: 'unknown', error: null, updatedAt: receipt.createdAt,
          result: { operationId: request.operationId, action: request.action, objective: request.objective, goalId: state.goal?.id },
        })
      }
      let observed: GoalObservation | null
      switch (request.action) {
        case 'set':
        case 'edit':
          observed = await port.set(request.objective ?? '')
          break
        case 'pause':
          observed = await port.pause()
          break
        case 'resume':
          observed = await port.resume()
          break
        case 'clear':
          observed = await port.clear()
          break
      }
      const resultOf = (saved: GoalState, applied: boolean) => goalResult(request.operationId, saved, session.takeover, applied)
      if (observed === null) {
        return resultOf(state, false)
      }
      const saved = await this.onGoalUpdated(sessionId, observed, next => withResult(receipt, resultOf(next, true)))
      return resultOf(saved, true)
    })
  }

  /** Reconcile a write that may already have run. Polling and replay can only read the native goal. */
  public async reconcile(pending: CommandRecord): Promise<Record<string, unknown>> {
    const sessionId = pending.sessionId
    if (sessionId === null || pending.method !== 'session.goal') throw new Error('Expected a session goal receipt')
    return this.kernel.serial(sessionId, async () => {
      const store = this.kernel.deps.store
      const latest = await store.commands.get(pending.commandId)
      if (latest?.outcome === 'accepted' && latest.result !== null) return latest.result
      if (latest?.outcome === 'rejected') throw new UseCaseError(latest.error?.code ?? 'goal_rejected', latest.error?.message ?? 'Goal operation rejected')
      const session = await this.kernel.requireSession(sessionId)
      const port = (await this.bindings.binding(sessionId)).session.goal
      const snapshot = await port?.get()
      const state = snapshot == null ? await store.goals.load(sessionId) : await this.onGoalUpdated(sessionId, snapshot)
      const intent = pending.result
      const operationId = String(intent?.operationId ?? pending.commandId)
      if (state === null) return { operationId, outcome: 'unknown', ok: false }
      const sameGoal = state.goal !== null && state.goal.id === intent?.goalId
      let applied = false
      if (snapshot != null) {
        switch (intent?.action) {
          case 'set':
          case 'edit':
            applied = snapshot.goal != null && snapshot.goal.objective === intent.objective
            break
          case 'pause':
            applied = sameGoal && snapshot.goal?.status === 'paused'
            break
          case 'resume':
            applied = sameGoal && snapshot.goal?.status === 'active'
            break
          case 'clear':
            applied = snapshot.empty && state.goal === null && state.lastOutcome?.id === intent.goalId
            break
        }
      }
      const result = goalResult(operationId, state, session.takeover, applied)
      if (applied) {
        await store.commands.settle({ ...pending, outcome: 'accepted', result, updatedAt: this.kernel.deps.clock.nowIso() })
      }
      return result
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
    const observed = await port.set(objective.trim())
    await deps.store.deliveries.transition(sessionId, clientMessageId, 'started', { at: deps.clock.nowIso() })
    if (observed !== null) await this.onGoalUpdated(sessionId, observed)
  }

  public async onGoalUpdated(sessionId: string, observation: GoalObservation, receiptFor?: (state: GoalState) => CommandReceipt | null): Promise<GoalState> {
    const deps = this.kernel.deps
    const session = await this.kernel.requireSession(sessionId)
    const state = (await deps.store.goals.load(sessionId)) ?? initialGoalState({ sessionId, runtime: session.runtimeType, runtimeId: session.runtimeId, sourceEpoch: deps.ids.newId('ep_') })
    const next = observeGoal(state, observation, { newId: () => deps.ids.newId('goal_'), now: deps.clock.nowIso() })
    if (next.revision !== state.revision || JSON.stringify(next) !== JSON.stringify(state)) {
      this.kernel.publish(await deps.store.goals.save(next, receiptFor?.(next) ?? null))
      this.emitGoal(sessionId, next, session.takeover)
    }
    return next
  }

  /**
   * `goal.state.updated` on `runtime.status` (device-meshcall 1.0 `RuntimeStatusEvent`): the v2 event name and the
   * client-shaped state, both inside `status`.
   */
  private emitGoal(sessionId: string, state: GoalState, takeover: boolean): void {
    this.kernel.emitSessionStatus(sessionId, { event: 'goal.state.updated', revision: state.revision, state: goalWire(state, takeover) as unknown as ContractStatusOf<'goal.state.updated'>['state'] })
  }
}

function goalResult(operationId: string, state: GoalState, takeover: boolean, applied: boolean) {
  return { operationId, outcome: applied ? 'applied' : 'unknown', ok: applied, state: goalWire(state, takeover) }
}
