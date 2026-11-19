import type { ReviewAddress, ReviewAttention, ReviewTarget } from '../../domain/collab/review.js'
import type { ReviewExecution, ReviewExecutionPhase, ReviewRequest, ReviewResult } from '../../domain/collab/review-execution.js'
import type { AgentActorRef } from './collab.js'

export interface ReviewTaskSnapshot {
  readonly taskId: string
  readonly contextId: string
  readonly revision: number
  readonly phase: ReviewExecutionPhase
  readonly reviewer?: ReviewAddress
  readonly attention?: ReviewAttention
  readonly result?: ReviewResult & { readonly runId: string; readonly round: number; readonly sha: string; readonly artifactId: string }
}

/** Review orchestration only uses this port; protocol and device routing stay in the adapter. */
export interface ReviewWorker {
  submit(actor: AgentActorRef, target: ReviewTarget, messageId: string, request: ReviewRequest): Promise<ReviewTaskSnapshot>
  get(actor: AgentActorRef, target: ReviewTarget, taskId: string): Promise<ReviewTaskSnapshot>
  resume(actor: AgentActorRef, target: ReviewTarget, taskId: string, contextId: string, messageId: string): Promise<ReviewTaskSnapshot>
  cancel(actor: AgentActorRef, target: ReviewTarget, taskId: string): Promise<ReviewTaskSnapshot>
}

export interface ReviewExecutionRepository {
  get(taskId: string): Promise<ReviewExecution | null>
  bySession(sessionId: string): Promise<ReviewExecution | null>
  list(): Promise<ReviewExecution[]>
  save(execution: ReviewExecution): Promise<void>
}

export interface ReviewAdmission {
  readonly depth: number
  readonly interrupt: boolean
  readonly project?: { readonly id: string; readonly cwd: string }
}

export interface ReviewExecutionUseCases {
  accept(actor: AgentActorRef, messageId: string, request: ReviewRequest, admission: ReviewAdmission): Promise<ReviewExecution>
  get(actor: AgentActorRef, id: string): Promise<ReviewExecution | null>
  list(actor: AgentActorRef): Promise<ReviewExecution[]>
  resume(actor: AgentActorRef, id: string, contextId: string, messageId: string): Promise<ReviewExecution | null>
  cancel(actor: AgentActorRef, id: string, allowed: boolean): Promise<ReviewExecution | null>
  tick(): Promise<void>
}
