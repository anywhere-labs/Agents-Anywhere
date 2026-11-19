import { createHash } from 'node:crypto'

import { CollabError, DEFAULT_LIMITS } from '../../domain/collab/index.js'
import {
  executionTransition, isTerminal, readReviewResult, submitReview,
  type ReviewExecution, type ReviewRequest,
} from '../../domain/collab/review-execution.js'
import type { ReviewAttention } from '../../domain/collab/review.js'
import type { AgentActorRef, Clock, SessionGateway } from '../ports/index.js'
import type { ReviewAdmission, ReviewExecutionRepository, ReviewExecutionUseCases } from '../ports/review.js'

type WorkerRuntime = {
  launch(execution: ReviewExecution): Promise<void>
  verify(execution: ReviewExecution): Promise<void>
  interrupt(execution: ReviewExecution): Promise<void>
  recover?(execution: ReviewExecution): Promise<boolean>
  failure?(execution: ReviewExecution): Promise<'timeout' | 'failed' | undefined>
}

export class ReviewExecutionService implements ReviewExecutionUseCases {
  private readonly pending = new Map<string, Promise<unknown>>()
  private ticking = false

  public constructor(
    private readonly tasks: ReviewExecutionRepository,
    private readonly deviceId: string,
    private readonly clock: Clock,
    private readonly gateway: Pick<SessionGateway, 'facts' | 'notices'>,
    private readonly runtime: WorkerRuntime,
    private readonly log: (message: string) => void,
  ) {}

  public async accept(actor: AgentActorRef, messageId: string, request: ReviewRequest, admission: ReviewAdmission): Promise<ReviewExecution> {
    const project = admission.project
    if (project === undefined) throw new CollabError('agent_scope_denied', 'Select a registered review project.')
    const id = createHash('sha256').update(JSON.stringify([actor.deviceId, actor.sessionId, messageId])).digest('hex')
    const ownerKey = JSON.stringify([actor.deviceId, actor.sessionId])
    return this.serial(ownerKey, async () => {
      const canonical = { ...request, cwd: project.cwd, projectId: project.id }
      const saved = await this.tasks.get(id)
      if (saved !== null) {
        if (JSON.stringify(saved.request) !== JSON.stringify(canonical)) throw new CollabError('invalid_argument', 'This message ID is already bound to a different review.')
        return saved
      }
      const owned = await this.list(actor)
      const prior = owned.find(other => other.request.runId === request.runId && other.request.round === request.round
        && (!isTerminal(other.phase) || other.phase === 'completed'))
      if (prior !== undefined) {
        if (JSON.stringify(prior.request) !== JSON.stringify(canonical)) {
          throw new CollabError('invalid_argument', 'This review round is already bound to a different candidate.')
        }
        return prior
      }
      if (owned.filter(task => !isTerminal(task.phase)).length >= DEFAULT_LIMITS.maxActiveChildren) {
        throw new CollabError('agent_children_exceeded', 'This session has reached its limit of active reviews.')
      }
      const execution: ReviewExecution = {
        id, messageId, request: canonical, contextId: `review_${request.runId}_${request.round}`,
        sessionId: `sess_${id.slice(0, 32)}`,
        owner: { deviceId: actor.deviceId, sessionId: actor.sessionId }, depth: admission.depth,
        phase: 'submitted', revision: 1, updatedAt: this.clock.nowIso(),
      }
      await this.tasks.save(execution)
      return execution
    })
  }

  public async get(actor: AgentActorRef, id: string): Promise<ReviewExecution | null> {
    const execution = await this.tasks.get(id)
    return execution !== null && execution.owner.deviceId === actor.deviceId && execution.owner.sessionId === actor.sessionId ? execution : null
  }

  public async list(actor: AgentActorRef): Promise<ReviewExecution[]> {
    return (await this.tasks.list()).filter(row => row.owner.deviceId === actor.deviceId && row.owner.sessionId === actor.sessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
  }

  public bySession(sessionId: string): Promise<ReviewExecution | null> {
    return this.tasks.bySession(sessionId)
  }

  public async resume(actor: AgentActorRef, id: string, contextId: string, messageId: string): Promise<ReviewExecution | null> {
    return this.serial(id, async () => {
      const current = await this.get(actor, id)
      if (current === null || current.contextId !== contextId) return null
      if (current.resumeMessageId === messageId) return current
      if (current.phase !== 'input-required' || current.attention?.code !== 'review_commit_unavailable') {
        throw new CollabError('invalid_argument', 'This review is not waiting for a candidate checkout retry.')
      }
      const next = { ...executionTransition(current, 'submitted', this.clock.nowIso()), resumeMessageId: messageId }
      await this.tasks.save(next)
      return next
    })
  }

  public async cancel(actor: AgentActorRef, id: string, allowed: boolean): Promise<ReviewExecution | null> {
    return this.serial(id, async () => {
      const execution = await this.get(actor, id)
      if (execution === null) return null
      if (!allowed) throw new CollabError('agent_authority_exceeded', 'This session cannot cancel the review.')
      if (execution.phase === 'canceled') return execution
      if (isTerminal(execution.phase) || this.launching.has(id)) throw new CollabError('agent_authority_exceeded', 'This session cannot cancel the review.')
      // Persist intent so a restart after a successful interrupt cannot classify it as a failed review.
      const canceling = { ...execution, cancelRequested: true }
      if (!execution.cancelRequested) await this.tasks.save(canceling)
      return this.finishCancellation(canceling)
    })
  }

  public async submit(sessionId: string, value: unknown): Promise<void> {
    const bound = await this.bySession(sessionId)
    if (bound === null) throw new CollabError('agent_scope_denied', 'No review is assigned to this session.')
    const report = readReviewResult(value)
    await this.serial(bound.id, async () => {
      const current = await this.tasks.get(bound.id)
      if (current === null) throw new CollabError('agent_scope_denied', 'The review is no longer available.')
      let ready = current
      if (current.phase === 'input-required' && current.attention?.code === 'waiting_approval') {
        const target = { deviceId: this.deviceId, sessionId }
        const notices = await this.gateway.notices(target, { ...current.owner, grantId: '' })
        if (notices.length === 0) ready = executionTransition(current, 'working', this.clock.nowIso())
      }
      if (ready.result === undefined) await this.runtime.verify(ready)
      const next = submitReview(ready, report, this.clock.nowIso())
      if (next !== current) await this.tasks.save(next)
    })
  }

  public async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await Promise.all((await this.tasks.list()).filter(row => !isTerminal(row.phase)).map(row => this.serial(row.id, async () => {
        const execution = await this.tasks.get(row.id)
        if (execution === null || isTerminal(execution.phase)) return
        await this.advance(execution)
      }).catch(() => this.log(`Review task ${row.id} will be reconciled on the next tick.`))))
    } finally {
      this.ticking = false
    }
  }

  private async advance(execution: ReviewExecution): Promise<void> {
    if (execution.cancelRequested) {
      await this.finishCancellation(execution)
      return
    }
    if (this.launching.has(execution.id)) return
    if (execution.phase === 'submitted') {
      // Persist a runnable phase before opening Claude. Its first turn may submit immediately.
      const working = executionTransition(execution, 'working', this.clock.nowIso())
      await this.tasks.save(working)
      void this.launch(working).catch(() => this.log(`Review task ${working.id} launch will be reconciled.`))
      return
    }
    if (execution.attention?.code === 'review_commit_unavailable') return
    const target = { deviceId: this.deviceId, sessionId: execution.sessionId }
    const actor = { ...execution.owner, grantId: '' }
    const view = await this.gateway.facts(target, actor)
    if (view === null || (view.signal.status === 'pending' && view.signal.latestTurnEndSeq === null)) {
      // The stable session and command IDs allow a retry after interruption during launch.
      if (!this.launching.has(execution.id)) await this.transition(execution, 'submitted')
      return
    }
    const notice = (await this.gateway.notices(target, actor))[0]
    if (notice !== undefined) {
      await this.transition(execution, 'input-required', { code: 'waiting_approval', message: notice.title, target, noticeId: notice.id })
      return
    }
    if (view.signal.status === 'error' || view.signal.status === 'blocked') {
      if (await this.runtime.recover?.(execution)) {
        if (execution.result === undefined) await this.transition(execution, 'working')
        else await this.finishReview(execution, target)
        return
      }
      await this.failReview(execution, target, true)
      return
    }
    if (view.signal.status === 'idle' && (view.signal.latestTurnEndSeq ?? 0) > 0) {
      if (execution.result === undefined) await this.failReview(execution, target, false)
      else await this.finishReview(execution, target)
      return
    }
    await this.transition(execution, 'working')
  }

  private async failReview(execution: ReviewExecution, target: NonNullable<ReviewAttention['target']>, runtimeFailed: boolean): Promise<void> {
    const failure = await this.runtime.failure?.(execution).catch(() => undefined)
    const attention = failure === 'timeout'
      ? { code: 'review_model_timeout', message: 'The model service timed out. Retry the review.' }
      : failure === 'failed' || runtimeFailed
        ? { code: 'review_runtime_failed', message: 'The reviewer could not finish the review.' }
        : { code: 'review_result_missing', message: 'The reviewer ended the turn without submitting a review result.' }
    await this.transition(execution, 'failed', { ...attention, target })
  }

  private async finishReview(execution: ReviewExecution, target: NonNullable<ReviewAttention['target']>): Promise<void> {
    try {
      await this.runtime.verify(execution)
    } catch (error) {
      await this.transition(execution, 'failed', { code: 'review_checkout_changed', message: error instanceof Error ? error.message : 'The review checkout changed.', target })
      return
    }
    await this.transition(execution, 'completed')
  }

  private async finishCancellation(execution: ReviewExecution): Promise<ReviewExecution> {
    await this.runtime.interrupt(execution)
    return this.transition(execution, 'canceled')
  }

  private readonly launching = new Set<string>()

  private async launch(execution: ReviewExecution): Promise<void> {
    this.launching.add(execution.id)
    try {
      await this.runtime.launch(execution)
    } catch (error) {
      await this.serial(execution.id, async () => {
        const current = await this.tasks.get(execution.id)
        if (current === null || current.phase !== 'working') return
        const code = typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'review_launch_unknown'
        if (code === 'review_launch_unknown' || code === 'command_outcome_unknown') return
        const message = error instanceof Error ? error.message : 'The review could not be started.'
        await this.transition(current, code === 'review_commit_unavailable' ? 'input-required' : 'failed', { code, message: message.slice(0, 600) })
      })
    } finally {
      this.launching.delete(execution.id)
    }
  }

  private async transition(execution: ReviewExecution, phase: ReviewExecution['phase'], attention?: ReviewAttention): Promise<ReviewExecution> {
    const next = executionTransition(execution, phase, this.clock.nowIso(), attention)
    if (next !== execution) await this.tasks.save(next)
    return next
  }

  private async serial<T>(id: string, execute: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id)
    const work = (previous?.catch(() => undefined) ?? Promise.resolve()).then(execute)
    this.pending.set(id, work)
    try {
      return await work
    } finally {
      if (this.pending.get(id) === work) this.pending.delete(id)
    }
  }
}
