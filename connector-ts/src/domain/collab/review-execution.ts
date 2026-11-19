import { CollabError } from './errors.js'
import { collaborationCheckout, GIT_COMMIT, isReviewRuntime, type ReviewAttention, type ReviewRuntimeType } from './review.js'

export const REVIEW_REQUEST = 'aa.review.request.v1'
export const REVIEW_RESUME = 'aa.review.resume.v1'
export const REVIEW_ARTIFACT = 'aa.review.result.v1'

export interface ReviewRequest {
  readonly runId: string
  readonly round: number
  readonly requirement: string
  readonly base: string
  readonly sha: string
  readonly runtimeId: string
  readonly runtimeType?: ReviewRuntimeType
  readonly cwd: string
  readonly projectId?: string
  readonly remote: string
}

export interface ReviewFinding {
  readonly description: string
  readonly evidence: string
}

export interface ReviewResult {
  readonly verdict: 'approved' | 'changes_requested'
  readonly summary: string
  readonly blockers: ReviewFinding[]
}

export type ReviewExecutionPhase = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled'

export type ReviewExecution = {
  readonly id: string
  readonly contextId: string
  readonly sessionId: string
  readonly owner: { readonly deviceId: string; readonly sessionId: string }
  readonly messageId: string
  readonly request: ReviewRequest
  readonly depth: number
  readonly phase: ReviewExecutionPhase
  readonly revision: number
  readonly updatedAt: string
  readonly attention?: ReviewAttention
  readonly result?: ReviewResult
  readonly resumeMessageId?: string
  readonly cancelRequested?: boolean
}

export function isTerminal(phase: ReviewExecutionPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'canceled'
}

export function executionTransition(execution: ReviewExecution, phase: ReviewExecutionPhase, at: string, attention?: ReviewAttention): ReviewExecution {
  if (isTerminal(execution.phase)) return execution
  if (phase === 'completed' && execution.result === undefined) throw new CollabError('invalid_argument', 'The reviewer has not submitted a result.')
  if (phase === execution.phase && JSON.stringify(execution.attention) === JSON.stringify(attention)) return execution
  const { attention: _previous, ...rest } = execution
  return { ...rest, phase, updatedAt: at, revision: execution.revision + 1, ...(attention === undefined ? {} : { attention }) }
}

export function submitReview(execution: ReviewExecution, result: ReviewResult, at: string): ReviewExecution {
  if (execution.result !== undefined && JSON.stringify(execution.result) === JSON.stringify(result)) return execution
  if (execution.phase !== 'working' || execution.cancelRequested || execution.result !== undefined) throw new CollabError('invalid_argument', 'This review is no longer accepting results.')
  return { ...execution, result, updatedAt: at, revision: execution.revision + 1 }
}

export function readReviewRequest(value: unknown): ReviewRequest {
  const input = object(value)
  const checkout = collaborationCheckout({ runId: input.runId, round: input.round, role: 'review', commit: input.sha, remote: input.remote })
  if (input.schema !== REVIEW_REQUEST || typeof input.base !== 'string' || !GIT_COMMIT.test(input.base) || input.base === checkout.commit
    || typeof input.requirement !== 'string' || !input.requirement.trim() || input.requirement.length > 50_000
    || typeof input.cwd !== 'string' || !input.cwd || input.cwd.length > 4_096
    || (input.runtimeType !== undefined && !isReviewRuntime(input.runtimeType))
    || typeof input.runtimeId !== 'string' || !input.runtimeId || input.runtimeId.length > 160
    || (input.projectId !== undefined && (typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 160))) {
    throw new CollabError('invalid_argument', 'Invalid review task input.')
  }
  return { runId: checkout.runId, round: checkout.round, sha: checkout.commit, base: input.base, requirement: input.requirement, cwd: input.cwd, runtimeId: input.runtimeId, ...(input.runtimeType === undefined ? {} : { runtimeType: input.runtimeType }), remote: checkout.remote ?? 'origin', ...(input.projectId === undefined ? {} : { projectId: input.projectId }) }
}

export function readReviewResult(value: unknown): ReviewResult {
  const { verdict, summary, blockers } = object(value)
  if ((verdict !== 'approved' && verdict !== 'changes_requested') || typeof summary !== 'string' || !summary.trim() || summary.length > 2_400
    || !Array.isArray(blockers) || blockers.length > 20 || (verdict === 'approved') !== (blockers.length === 0)) {
    throw new CollabError('invalid_argument', 'Submit a verdict, summary, and matching blocking findings.')
  }
  const findings = blockers.map(value => {
    const { description, evidence } = object(value)
    if (typeof description !== 'string' || !description.trim() || description.length > 600
      || typeof evidence !== 'string' || !evidence.trim() || evidence.length > 300) {
      throw new CollabError('invalid_argument', 'Each blocking finding requires a description and a file location or evidence.')
    }
    return { description, evidence }
  })
  return { verdict, summary, blockers: findings }
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Classifies a model failure reported by a trusted native runtime. */
export function modelFailureReason(text: string): 'timeout' | 'failed' {
  return /\b(?:API Error:\s*(?:408|504|524)\b|timed? out|timeout)\b/iu.test(text) ? 'timeout' : 'failed'
}
