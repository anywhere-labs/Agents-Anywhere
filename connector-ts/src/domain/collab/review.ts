import { CollabError } from './errors.js'

export type ReviewPhase = 'starting' | 'implementing' | 'preparing_review' | 'reviewing' | 'returning' | 'delivered' | 'blocked'
export type ReviewAddress = { deviceId: string; sessionId: string }
export type ReviewRuntimeType = 'claude' | 'pi'
export type ReviewTarget = { runtimeType?: ReviewRuntimeType; deviceId: string; runtimeId: string; cwd: string; projectId?: string }
export type ReviewEvidence = { itemId: string; seq: number }
export type ReviewCheck = { sha: string; command: string; exitCode: number; itemId: string }
export type ReviewChanges = { summary: string; patch: string; truncated: boolean }
export type ReviewDecision = ReviewEvidence & { verdict: 'approved' | 'changes_requested'; summary: string; blockers: string[] }
export interface ReviewTaskReference {
  readonly messageId: string
  readonly taskId?: string
  readonly contextId?: string
  readonly revision?: number
  readonly resumeMessageId?: string
}

export type ReviewRound = {
  number: number
  sha: string
  implementation: ReviewEvidence
  checks: ReviewCheck[]
  checksComplete: boolean
  changes: ReviewChanges
  task?: ReviewTaskReference
  reviewer?: ReviewAddress
  review?: ReviewDecision
  failure?: ReviewAttemptFailure
}
export type ReviewAttemptFailure = { taskId: string; attention: ReviewAttention }
export type ReviewAttention = { code: string; message: string; target?: ReviewAddress; noticeId?: string }

/** A run owns every candidate and the review and check evidence attached to that candidate. */
export type ReviewRun = {
  id: string
  phase: ReviewPhase
  requirement: string
  base: string
  remote: string
  implementation: ReviewTarget
  review: ReviewTarget
  codeSession?: ReviewAddress
  since: number
  rounds: ReviewRound[]
  attention?: ReviewAttention
  attempt: number
}

export function isReviewRuntime(value: unknown): value is ReviewRuntimeType {
  return value === 'claude' || value === 'pi'
}

export const MAX_REVIEW_ROUNDS = 3

export function recordCandidate(run: ReviewRun, candidate: Omit<ReviewRound, 'number' | 'reviewer' | 'review' | 'task' | 'failure'>): ReviewRun {
  if (run.phase !== 'implementing' || !GIT_COMMIT.test(candidate.sha) || candidate.sha === run.base || run.rounds.some(round => round.sha === candidate.sha) || run.rounds.length >= MAX_REVIEW_ROUNDS) {
    throw new CollabError('invalid_argument', 'This run cannot accept that candidate commit.')
  }
  if (candidate.checks.some(check => check.sha !== candidate.sha)) throw new CollabError('invalid_argument', 'The checks must refer to the candidate commit.')
  return {
    ...clearAttention(run), phase: 'preparing_review', attempt: 0,
    rounds: [...run.rounds, { ...candidate, number: run.rounds.length + 1 }],
  }
}

export function startCandidateReview(run: ReviewRun, reviewer: ReviewAddress): ReviewRun {
  const round = run.rounds.at(-1)
  if (run.phase !== 'preparing_review' || round === undefined) throw new CollabError('invalid_argument', 'There is no candidate to review.')
  return { ...clearAttention(run), phase: 'reviewing', rounds: [...run.rounds.slice(0, -1), { ...round, reviewer }] }
}

export function recordVerdict(run: ReviewRun, sha: unknown, decision: ReviewDecision): ReviewRun {
  const round = run.rounds.at(-1)
  if (run.phase !== 'reviewing' || round === undefined || sha !== round.sha) {
    throw new CollabError('invalid_argument', 'The review must refer to this round’s exact candidate commit.')
  }
  if ((decision.verdict === 'approved') !== (decision.blockers.length === 0)) {
    throw new CollabError('invalid_argument', 'The verdict and its blocking findings disagree.')
  }
  const updated = { ...clearAttention(run), rounds: [...run.rounds.slice(0, -1), { ...round, review: decision }] }
  if (decision.verdict === 'approved' && checksPassed(round)) return { ...updated, phase: 'delivered' }
  if (round.number < MAX_REVIEW_ROUNDS) return { ...updated, phase: 'returning' }
  return {
    ...updated,
    phase: 'blocked',
    attention: { code: 'review_retry_limit', message: 'The review still has blocking findings or missing checks after two revisions.' },
  }
}

export function checksPassed(round: ReviewRound): boolean {
  return round.checksComplete && round.checks.length > 0 && round.checks.every(check => check.sha === round.sha && check.exitCode === 0)
}

export function clearAttention(run: ReviewRun): ReviewRun {
  const { attention: _attention, ...active } = run
  return active
}

export interface CollaborationCheckout {
  readonly runId: string
  readonly role: 'implement' | 'review'
  readonly round: number
  readonly commit: string
  readonly remote?: string
}

export const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
export const GIT_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

export function collaborationCheckout(value: unknown): CollaborationCheckout {
  const data = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const { runId, role, round, commit, remote } = data
  if (typeof runId !== 'string' || !/^review_[a-f0-9]{32}$/u.test(runId)
    || (role !== 'implement' && role !== 'review')
    || typeof round !== 'number' || !Number.isInteger(round) || round < 1 || round > MAX_REVIEW_ROUNDS
    || (role === 'implement' && round !== 1)
    || typeof commit !== 'string' || !GIT_COMMIT.test(commit)
    || (remote !== undefined && (typeof remote !== 'string' || !GIT_REMOTE.test(remote)))) {
    throw new CollabError('invalid_argument', 'The collaboration checkout needs a valid run, role, round and complete Git SHA.')
  }
  return { runId, role, round, commit, ...(remote !== undefined ? { remote } : {}) }
}

export function reviewRef(runId: string, round: number): string {
  return `refs/heads/aa-review/${runId}/${round}`
}
