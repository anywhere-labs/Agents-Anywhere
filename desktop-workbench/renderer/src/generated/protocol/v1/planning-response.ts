/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact planning-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Code = string | null
export type Execution = "not_requested" | "accepted" | "started" | "rejected" | "unknown"
export type Message = string | null
export type Ok = boolean
export type Operationid = string
export type Outcome = "applied" | "pending" | "rejected" | "unknown"
export type Retryable = false
export type Actions = (
  "enter_plan" | "exit_plan" | "submit_task" | "approve_and_execute" | "request_revision" | "dismiss_review"
)[]
export type Contentstreaming = "native_delta" | "final_only"
export type Reason = string | null
export type Supported = boolean
export type Content = string
export type Contentstate = "drafting" | "failed" | "interrupted"
export type Draftid = string
export type Planid = string
export type Revision = number
export type Seq = number
export type Effectivemode = "plan" | "normal" | "unknown"
export type Epoch = string
export type Execution1 = {
  [k: string]: unknown
} | null
export type Executionprogress = {
  [k: string]: unknown
} | null
export type Freshness = "fresh" | "stale" | "unknown"
export type Operation = {
  [k: string]: unknown
} | null
export type Contenthash = string
export type Contentstate1 = "ready"
export type Createdat = string | null
export type Markdown = string
export type Planid1 = string
export type Revision1 = number
export type Sourceturnid = string | null
export type Title = string
export type Proposals = PlanDocument[]
export type Requestedmode = ("plan" | "normal") | null
export type Actions1 = (
  "enter_plan" | "exit_plan" | "submit_task" | "approve_and_execute" | "request_revision" | "dismiss_review"
)[]
export type Contenthash1 = string
export type Planid2 = string
export type Planrevision = number
export type Reviewid = string
export type Status = "open" | "responding" | "approved" | "revision_requested" | "dismissed" | "withdrawn" | "unknown"
export type Revision2 = number
export type Runtime = string
export type Runtimeid = string | null
export type Sessionid = string

export interface PlanningResponse {
  code?: Code
  details?: Details
  execution?: Execution
  message?: Message
  ok: Ok
  operationId: Operationid
  outcome: Outcome
  retryable?: Retryable
  state?: PlanningState | null
}
export interface Details {
  [k: string]: unknown
}
export interface PlanningState {
  capabilities?: PlanningCapabilities
  draft?: PlanDraft | null
  effectiveMode?: Effectivemode
  epoch?: Epoch
  execution?: Execution1
  executionProgress?: Executionprogress
  freshness?: Freshness
  operation?: Operation
  proposal?: PlanDocument | null
  proposals?: Proposals
  requestedMode?: Requestedmode
  review?: PlanReview | null
  revision?: Revision2
  runtime: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
}
export interface PlanningCapabilities {
  actions?: Actions
  contentStreaming?: Contentstreaming
  reason?: Reason
  supported?: Supported
  [k: string]: unknown
}
export interface PlanDraft {
  content: Content
  contentState: Contentstate
  draftId: Draftid
  planId: Planid
  revision: Revision
  seq: Seq
}
export interface PlanDocument {
  contentHash: Contenthash
  contentState?: Contentstate1
  createdAt?: Createdat
  markdown: Markdown
  planId: Planid1
  revision: Revision1
  sourceTurnId?: Sourceturnid
  title: Title
}
export interface PlanReview {
  actions?: Actions1
  contentHash: Contenthash1
  planId: Planid2
  planRevision: Planrevision
  reviewId: Reviewid
  status: Status
}
