// ported from Agents-Anywhere v2 connector/connector/planning/domain/session.py @98dd0e6e5 (SessionPlanning, content_hash, plan_title)
//
import { sha256Hex } from '../identity/hash.js'
import { planningStableId } from '../identity/planning.js'

/**
 * Planning as an explicit sub-aggregate of the Conversation (02-domain-model.md §5.2, §7 item 2): mode,
 * document, review and execution are separate facts; every document revision is immutable and carries a content hash.
 */
export const MAX_PLAN_BYTES = 2 * 1024 * 1024

export type PlanningMode = 'plan' | 'normal' | 'unknown'
export type Freshness = 'fresh' | 'stale' | 'unknown'
export type PlanningAction = 'enter_plan' | 'exit_plan' | 'submit_task' | 'approve_and_execute' | 'request_revision' | 'dismiss_review'
export type ReviewStatus = 'open' | 'responding' | 'approved' | 'revision_requested' | 'dismissed' | 'withdrawn' | 'unknown'

export class PlanningConflict extends Error {
  public readonly code = 'planning_conflict'
  public constructor(message: string) {
    super(message)
    this.name = 'PlanningConflict'
  }
}

export class PlanningInvalid extends Error {
  public readonly code = 'invalid_argument'
  public constructor(message: string) {
    super(message)
    this.name = 'PlanningInvalid'
  }
}

export interface PlanDocument {
  readonly planId: string
  readonly revision: number
  readonly contentHash: string
  readonly title: string
  readonly markdown: string
  readonly sourceTurnId: string | null
  readonly contentState: 'ready'
  readonly createdAt: string
}

export interface PlanDraft {
  readonly draftId: string
  readonly planId: string
  readonly revision: number
  readonly seq: number
  readonly content: string
  readonly contentState: 'drafting' | 'failed' | 'interrupted'
}

export interface PlanReview {
  readonly reviewId: string
  readonly planId: string
  readonly planRevision: number
  readonly contentHash: string
  readonly status: ReviewStatus
  readonly actions: readonly PlanningAction[]
}

/** A native review request (e.g. Claude's ExitPlanMode approval), identified by its notice. */
export interface NativeReview {
  readonly noticeId: string
  readonly [key: string]: unknown
}

export interface PlanningState {
  readonly sessionId: string
  readonly runtime: string
  readonly effectiveMode: PlanningMode
  readonly requestedMode: 'plan' | 'normal' | null
  readonly freshness: Freshness
  readonly revision: number
  readonly epoch: string
  readonly draft: PlanDraft | null
  /** Metadata of every revision; the markdown of older revisions lives in the document store only. */
  readonly proposals: readonly PlanDocument[]
  readonly review: PlanReview | null
  readonly nativeReview: NativeReview | null
  readonly operation: Readonly<Record<string, unknown>> | null
  readonly execution: Readonly<Record<string, unknown>> | null
  readonly executionProgress: Readonly<Record<string, unknown>> | null
  /** Native plan item id → AA planId, fixed on first sight. */
  readonly planIds: Readonly<Record<string, string>>
}

export function initialPlanning(sessionId: string, runtime: string, epoch: string): PlanningState {
  return {
    sessionId,
    runtime,
    effectiveMode: 'unknown',
    requestedMode: null,
    freshness: 'unknown',
    revision: 0,
    epoch,
    draft: null,
    proposals: [],
    review: null,
    nativeReview: null,
    operation: null,
    execution: null,
    executionProgress: null,
    planIds: {},
  }
}

function utf8Length(text: string): number {
  if (!text.isWellFormed()) throw new PlanningInvalid('计划正文包含无效字符。')
  return Buffer.byteLength(text, 'utf8')
}

/** Content hash: sha256 of the strict UTF-8 text; empty or > 2 MiB plans cannot be reviewed. */
export function planContentHash(text: string): string {
  if (!text.trim() || utf8Length(text) > MAX_PLAN_BYTES) throw new PlanningInvalid('计划正文为空或超过 2 MiB，不能提交审阅。')
  return `sha256:${sha256Hex(text)}`
}

const MARKDOWN_PREFIX = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/u
// Underscore runs at a word boundary, where word characters are Unicode letters, digits and `_`.
const MARKDOWN_INLINE = /`+|\*+|(?<![\p{L}\p{N}_])_+|_+(?![\p{L}\p{N}_])/gu

/** First heading of any level, else the first line of prose, without Markdown. */
export function planTitle(text: string): string {
  const lines = text.split(/\r\n|\r|\n/u).map(line => line.trim()).filter(line => line.length > 0)
  const heading = lines.find(line => /^#{1,6}\s+/u.test(line))
  const source = heading ?? lines[0] ?? ''
  const title = source.replace(MARKDOWN_PREFIX, '').replace(MARKDOWN_INLINE, '').trim().replace(/[:：]+$/u, '').trim()
  if (!title) return '计划'
  const chars = Array.from(title)
  return chars.length <= 60 ? title : `${chars.slice(0, 59).join('')}…`
}

function bump(state: PlanningState, patch: Partial<PlanningState>): PlanningState {
  return { ...state, ...patch, revision: state.revision + 1 }
}

export function observeMode(state: PlanningState, mode: PlanningMode): PlanningState {
  const freshness: Freshness = mode !== 'unknown' ? 'fresh' : 'unknown'
  if (state.effectiveMode === mode && state.requestedMode === null && state.freshness === freshness) return state
  return bump(state, { effectiveMode: mode, requestedMode: mode === state.requestedMode ? null : state.requestedMode, freshness })
}

export function requestMode(state: PlanningState, mode: 'plan' | 'normal'): PlanningState {
  return bump(state, { requestedMode: mode })
}

export function planIdFor(state: PlanningState, nativeId: string): { state: PlanningState; planId: string } {
  const known = state.planIds[nativeId]
  if (known !== undefined) return { state, planId: known }
  // A revision requested in review keeps the reviewed planId, so the next native item is that plan's next version.
  const planId = state.review !== null && state.review.status === 'revision_requested'
    ? state.review.planId
    : planningStableId('plan_', state.sessionId, nativeId)
  return { state: { ...state, planIds: { ...state.planIds, [nativeId]: planId } }, planId }
}

export function nextVersion(state: PlanningState, planId: string): number {
  return 1 + state.proposals.filter(p => p.planId === planId).reduce((max, p) => Math.max(max, p.revision), 0)
}

export function currentProposal(state: PlanningState): PlanDocument | null {
  return state.proposals[state.proposals.length - 1] ?? null
}

export function updateDraft(state: PlanningState, nativeId: string, text: string, append: boolean): PlanningState {
  const draftId = planningStableId('draft_', state.sessionId, nativeId)
  let next = state
  let draft = state.draft
  if (draft === null || draft.draftId !== draftId) {
    const assigned = planIdFor(next, nativeId)
    next = assigned.state
    draft = { draftId, planId: assigned.planId, revision: nextVersion(next, assigned.planId), seq: 0, content: '', contentState: 'drafting' }
  }
  const value = append ? draft.content + text : text
  if (utf8Length(value) > MAX_PLAN_BYTES) {
    return bump(next, { draft: { ...draft, contentState: 'failed' } })
  }
  return bump(next, { draft: { ...draft, content: value, seq: draft.seq + 1, contentState: 'drafting' } })
}

const DEFAULT_REVIEW_ACTIONS: readonly PlanningAction[] = ['approve_and_execute', 'request_revision', 'dismiss_review']

function openReview(state: PlanningState, proposal: PlanDocument, nativeReview: NativeReview | null, actions: readonly PlanningAction[] | null): PlanningState {
  if (actions !== null && actions.length === 0) return bump(state, { nativeReview, review: null })
  let reviewId = planningStableId('review_', proposal.planId, String(proposal.revision))
  if (actions !== null && nativeReview !== null) reviewId = planningStableId('review_', reviewId, nativeReview.noticeId)
  return bump(state, {
    nativeReview,
    review: {
      reviewId,
      planId: proposal.planId,
      planRevision: proposal.revision,
      contentHash: proposal.contentHash,
      status: 'open',
      actions: actions ?? DEFAULT_REVIEW_ACTIONS,
    },
  })
}

export type FinalizeResult = { readonly state: PlanningState; readonly changed: boolean; readonly document: PlanDocument | null }

/**
 * A finished plan: a new immutable revision unless it repeats the current one. The new document comes back
 * separately so the store can keep every revision's markdown (`plan_documents`) while the state keeps metadata.
 */
export function finalize(state: PlanningState, input: { nativeId: string; text: string; turnId: string | null; at: string; nativeReview: NativeReview | null; reviewActions: readonly PlanningAction[] | null }): FinalizeResult {
  const digest = planContentHash(input.text)
  const assigned = planIdFor(state, input.nativeId)
  let next = assigned.state
  const current = currentProposal(next)
  if (current !== null && current.planId === assigned.planId && current.contentHash === digest) {
    const sameReview = JSON.stringify(next.nativeReview) === JSON.stringify(input.nativeReview)
    if (input.reviewActions === null || sameReview) return { state: next, changed: next !== state, document: null }
    return { state: openReview(next, current, input.nativeReview, input.reviewActions), changed: true, document: null }
  }
  const document: PlanDocument = {
    planId: assigned.planId,
    revision: nextVersion(next, assigned.planId),
    contentHash: digest,
    title: planTitle(input.text),
    markdown: input.text,
    sourceTurnId: input.turnId,
    contentState: 'ready',
    createdAt: input.at,
  }
  next = {
    ...next,
    // Older revisions keep their metadata here; the markdown stays in the document store only.
    proposals: [...next.proposals.map(p => ({ ...p, markdown: '' })), document],
    execution: null,
    executionProgress: null,
    draft: null,
  }
  return { state: openReview(next, document, input.nativeReview, input.reviewActions), changed: true, document }
}

export interface ReviewRequest {
  readonly reviewId?: string | null
  readonly planId?: string | null
  readonly planRevision?: number | null
  readonly contentHash?: string | null
  readonly expectedRevision?: number | null
  readonly epoch?: string | null
}

/** "Approve and execute" must name the current version and its hash; anything else is a conflict. */
export function requireReview(state: PlanningState, request: ReviewRequest, allowApproved = false): PlanReview {
  const review = state.review
  const statuses: ReviewStatus[] = allowApproved ? ['open', 'approved'] : ['open']
  if (review === null || !statuses.includes(review.status) || state.freshness !== 'fresh') {
    throw new PlanningConflict('计划审阅已处理、已失效或正在重新核对。')
  }
  if (request.reviewId !== review.reviewId || request.planId !== review.planId || request.planRevision !== review.planRevision || request.contentHash !== review.contentHash) {
    throw new PlanningConflict('计划版本已经变化，请重新打开计划确认。')
  }
  if (request.expectedRevision !== undefined && request.expectedRevision !== null && request.expectedRevision !== state.revision) {
    throw new PlanningConflict('会话状态已变化，请刷新后确认。')
  }
  if (request.epoch !== undefined && request.epoch !== null && request.epoch !== state.epoch) {
    throw new PlanningConflict('原生控制实例已变化，请重新核对计划。')
  }
  return review
}

export function setReviewStatus(state: PlanningState, status: ReviewStatus): PlanningState {
  if (state.review === null || state.review.status === status) return state
  return bump(state, { review: { ...state.review, status } })
}

/** The list-level summary the Server may store (no content). */
export function planStateSummary(state: PlanningState | null): 'none' | 'planning' | 'awaiting_review' {
  if (state === null) return 'none'
  if (state.review !== null && (state.review.status === 'open' || state.review.status === 'responding')) return 'awaiting_review'
  if (state.effectiveMode === 'plan' || state.draft !== null) return 'planning'
  return 'none'
}

/** The client shape (`PlanningState` in protocol 1.2); `includeHistory` adds every revision's metadata. */
export function planningWire(state: PlanningState, includeHistory = false): Record<string, unknown> {
  const value: Record<string, unknown> = {
    sessionId: state.sessionId,
    runtime: state.runtime,
    effectiveMode: state.effectiveMode,
    requestedMode: state.requestedMode,
    freshness: state.freshness,
    revision: state.revision,
    epoch: state.epoch,
    draft: state.draft,
    proposal: currentProposal(state),
    review: state.review,
    operation: state.operation,
    execution: state.execution,
    executionProgress: state.executionProgress,
  }
  if (includeHistory) value.proposals = state.proposals
  return structuredClone(value)
}

/** `PlanningState.capabilities` in protocol 1.2: which planning commands this session accepts now. */
export interface PlanningCapabilities {
  readonly supported: boolean
  readonly actions: readonly PlanningAction[]
  readonly contentStreaming: 'native_delta' | 'final_only'
  readonly reason: string | null
}

/**
 * The commands a session accepts, from the Runtime's capabilities: `session.planning` (switch the mode) and
 * `session.plan_review` (answer a review). `submit_task` (plan mode, then the task as a message) is not listed: it is accepted wherever `enter_plan` is.
 */
export function planningCapabilities(input: { readonly modes: boolean; readonly review: boolean }): PlanningCapabilities {
  const actions: PlanningAction[] = [
    ...(input.modes ? (['enter_plan', 'exit_plan'] as const) : []),
    ...(input.review ? DEFAULT_REVIEW_ACTIONS : []),
  ]
  const supported = actions.length > 0
  return { supported, actions, contentStreaming: 'final_only', reason: supported ? null : '该会话不支持原生计划模式。' }
}
