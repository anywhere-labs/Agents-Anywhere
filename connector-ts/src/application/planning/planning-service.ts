import {
  finalize as finalizePlan,
  initialPlanning,
  observeMode,
  planningWire,
  requireReview,
  setReviewStatus,
  type PlanningState,
} from '../../domain/planning/index.js'
import { UseCaseError } from '../errors.js'
import type { CommandReceipt, RuntimeEvent } from '../ports/index.js'
import type { RuntimeBindings } from '../session/bindings.js'
import type { SessionKernel } from '../session/kernel.js'
import { withResult } from '../session/receipts.js'

/** `session.planning` request: a mode switch or a review action on the current plan version. */
export interface PlanningRequest {
  command: string
  operationId: string
  reviewId?: string | null
  planId?: string | null
  planRevision?: number | null
  contentHash?: string | null
  expectedRevision?: number | null
  epoch?: string | null
  feedback?: string | null
}

/** Plan mode and plan review of a session (runtime-workflows 1.2 planning). */
export class PlanningService {
  public constructor(private readonly kernel: SessionKernel, private readonly bindings: RuntimeBindings) {}

  private async planningOf(sessionId: string): Promise<PlanningState> {
    const session = await this.kernel.requireSession(sessionId)
    return (await this.kernel.deps.store.planning.load(sessionId)) ?? initialPlanning(sessionId, session.runtimeType, this.kernel.deps.ids.newId('ep_'))
  }

  /** `session.planning`: mode switches and review actions; approval must name the current plan version. */
  public async planning(sessionId: string, request: PlanningRequest, receipt?: CommandReceipt | null): Promise<Record<string, unknown>> {
    return this.kernel.serial(sessionId, async () => {
      let state = await this.planningOf(sessionId)
      const binding = await this.bindings.binding(sessionId)
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
      // A v2 `PlanningResponse` (`CommandAck.r`), the body the secure channel returns as is; the state is the one saved.
      const result = {
        operationId: request.operationId,
        outcome: 'applied',
        ok: true,
        ...(request.command === 'approve_and_execute' ? { execution: 'accepted' } : {}),
        state: planningWire(state),
      }
      const commit = await this.kernel.deps.store.planning.save(state, null, withResult(receipt, result))
      this.kernel.publish(commit)
      this.emitPlanning(sessionId, state)
      return result
    })
  }

  /**
   * `/plan` on a new session: plan mode is on before the first message goes out; a
   * Runtime without a planning mode, or a switch that fails, rejects the message instead of sending it plainly.
   */
  public async enterPlanForCreation(sessionId: string): Promise<void> {
    const binding = await this.bindings.binding(sessionId)
    if (binding.session.planning === undefined) throw new UseCaseError('planning_unavailable', 'This Runtime has no planning mode.')
    await binding.session.planning.setMode('plan')
    await this.savePlanning(sessionId, observeMode(await this.planningOf(sessionId), 'plan'))
  }

  public async onPlanUpdated(sessionId: string, event: Extract<RuntimeEvent, { type: 'plan.updated' }>): Promise<void> {
    if (event.document === undefined) return
    const state = await this.planningOf(sessionId)
    const result = finalizePlan(state, {
      nativeId: event.planId,
      text: event.document.markdown,
      turnId: event.turnId ?? null,
      at: this.kernel.deps.clock.nowIso(),
      nativeReview: null,
      reviewActions: null,
    })
    if (!result.changed) return
    this.kernel.publish(await this.kernel.deps.store.planning.save(result.state, result.document))
    this.emitPlanning(sessionId, result.state)
  }

  /** The Runtime asked for a review of its plan (a `plan_review` interaction carrying the plan). */
  public async onPlanReview(sessionId: string, review: { readonly noticeId: string; readonly planId: string; readonly markdown: string; readonly turnId: string | null; readonly at: string }): Promise<void> {
    const state = await this.planningOf(sessionId)
    const result = finalizePlan(state, { nativeId: review.planId, text: review.markdown, turnId: review.turnId, at: review.at, nativeReview: { noticeId: review.noticeId }, reviewActions: ['approve_and_execute', 'request_revision', 'dismiss_review'] })
    this.kernel.publish(await this.kernel.deps.store.planning.save(result.state, result.document))
    this.emitPlanning(sessionId, result.state)
  }

  public async onPlanningMode(sessionId: string, mode: 'plan' | 'normal'): Promise<void> {
    await this.savePlanning(sessionId, observeMode(await this.planningOf(sessionId), mode))
  }

  /** Saves a changed planning state (no new document) and tells the session's subscribers. */
  private async savePlanning(sessionId: string, next: PlanningState): Promise<void> {
    const current = await this.kernel.deps.store.planning.load(sessionId)
    if (current !== null && JSON.stringify(current) === JSON.stringify(next)) return
    this.kernel.publish(await this.kernel.deps.store.planning.save(next, null))
    this.emitPlanning(sessionId, next)
  }

  /**
   * `planning.state.updated` on `runtime.status` (device-meshcall 1.0 `RuntimeStatusEvent`): the v2 event name and
   * the client-shaped state, both inside `status`.
   */
  private emitPlanning(sessionId: string, state: PlanningState): void {
    this.kernel.emitSessionStatus(sessionId, { event: 'planning.state.updated', revision: state.revision, state: planningWire(state) })
  }
}
