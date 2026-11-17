import { interaction as interactionRules } from '../../domain/conversation/index.js'
import type { PlanningService } from '../planning/planning-service.js'
import type { RuntimeEvent, RuntimeSession } from '../ports/index.js'
import type { RuntimeBindings } from '../session/bindings.js'
import type { SessionKernel } from '../session/kernel.js'

/** Interactions (Notices): what the Runtime asks a person (approvals, forms, plan reviews), and their answers. */
export class InteractionService {
  public constructor(
    private readonly kernel: SessionKernel,
    private readonly bindings: RuntimeBindings,
    private readonly planning: PlanningService,
  ) {}

  /** `session.respondNotice`: first answer wins; forwarding failure reopens the interaction. */
  public async respondNotice(sessionId: string, noticeId: string, responseId: string, answer: Parameters<RuntimeSession['respond']>[1]): Promise<{ status: string }> {
    const store = this.kernel.deps.store
    const decision = await store.interactions.respond(sessionId, noticeId, responseId)
    if (decision.kind === 'duplicate') return { status: decision.interaction.state }
    try {
      const binding = await this.bindings.binding(sessionId)
      await binding.session.respond(noticeId, answer)
    } catch (error) {
      await store.interactions.save(interactionRules.reopen(decision.interaction))
      throw error
    }
    return { status: 'responding' }
  }

  public async onInteractionOpened(sessionId: string, event: Extract<RuntimeEvent, { type: 'interaction.opened' }>): Promise<void> {
    const deps = this.kernel.deps
    const at = deps.clock.nowIso()
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
    await deps.store.interactions.save(interaction)
    if (event.kind === 'plan_review' && event.plan !== undefined) {
      await this.planning.onPlanReview(sessionId, { noticeId: event.interactionId, planId: event.plan.planId, markdown: event.plan.markdown, turnId: event.turnId ?? null, at })
    }
    if (event.kind === 'approval') await this.kernel.patchSession(sessionId, { status: 'waiting_approval' })
    deps.live.emit('runtime.notice.updated', { sessionId, notice })
  }

  public async onInteractionResolved(sessionId: string, interactionId: string, resolution: 'answered' | 'withdrawn' | 'expired'): Promise<void> {
    const deps = this.kernel.deps
    const current = await deps.store.interactions.get(sessionId, interactionId)
    if (current === null) return
    const at = deps.clock.nowIso()
    const next = resolution === 'answered' ? interactionRules.resolve(current, resolution, at) : interactionRules.expire(current, resolution, at)
    await deps.store.interactions.save(next)
    const session = await this.kernel.requireSession(sessionId)
    if (session.status === 'waiting_approval' && (await deps.store.interactions.list(sessionId, true)).length === 0) await this.kernel.patchSession(sessionId, { status: 'running' })
    deps.live.emit('runtime.notice.updated', { sessionId, notice: { ...next.payload, noticeId: interactionId, status: next.state === 'resolved' ? 'resolved' : 'expired' } })
  }
}
