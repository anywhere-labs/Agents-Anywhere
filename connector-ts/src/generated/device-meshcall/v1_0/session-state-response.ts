/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-state-response. Do not edit; run `yarn contracts:generate`. */

export type Bindinggeneration = number
export type Actions = ("set" | "edit" | "pause" | "resume" | "clear")[]
export type Reason = string | null
export type Supported = boolean
export type Externalsessionid = string | null
export type Freshness = "fresh" | "stale" | "unknown"
export type Createdat = string
export type Endedat = string | null
export type Id = string
export type Iterations = number | null
export type Lastreason = string | null
export type Objective = string
export type Sourceturnid = string | null
export type Status =
  "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete" | "failed" | "cleared" | "replaced"
export type Timeusedseconds = number | null
export type Tokenbudget = number | null
export type Tokensused = number | null
export type Updatedat = string
export type Pendingoperationid = string | null
export type Revision = number
export type Runtime = string
export type Runtimeid = string | null
export type Sessionid = string
export type Sourceepoch = string
export type Sourcerevision = number
export type Actions1 = (
  "enter_plan" | "exit_plan" | "submit_task" | "approve_and_execute" | "request_revision" | "dismiss_review"
)[]
export type Contentstreaming = "native_delta" | "final_only"
export type Reason1 = string | null
export type Supported1 = boolean
export type Content = string
export type Contentstate = "drafting" | "failed" | "interrupted"
export type Draftid = string
export type Planid = string
export type Revision1 = number
export type Seq = number
export type Effectivemode = "plan" | "normal" | "unknown"
export type Epoch = string
export type Execution = {
  [k: string]: unknown
} | null
export type Executionprogress = {
  [k: string]: unknown
} | null
export type Freshness1 = "fresh" | "stale" | "unknown"
export type Operation = {
  [k: string]: unknown
} | null
export type Contenthash = string
export type Contentstate1 = "ready"
export type Createdat1 = string | null
export type Markdown = string
export type Planid1 = string
export type Revision2 = number
export type Sourceturnid1 = string | null
export type Title = string
export type Proposals = PlanDocument[]
export type Requestedmode = ("plan" | "normal") | null
export type Actions2 = (
  "enter_plan" | "exit_plan" | "submit_task" | "approve_and_execute" | "request_revision" | "dismiss_review"
)[]
export type Contenthash1 = string
export type Planid2 = string
export type Planrevision = number
export type Reviewid = string
export type Status1 = "open" | "responding" | "approved" | "revision_requested" | "dismissed" | "withdrawn" | "unknown"
export type Revision3 = number
export type Runtime1 = string
export type Runtimeid1 = string | null
export type Sessionid1 = string
export type Createdat2 = string
export type Error = {
  [k: string]: unknown
} | null
export type Externalsessionid1 = string | null
export type Runtime2 = string
export type Sessionid2 = string
export type Status2 = "idle" | "waiting" | "pending" | "running" | "stopping" | "waiting_approval" | "error" | "blocked"
export type Statusreason = string | null
export type Updatedat1 = string
export type Updatedseq = number

/**
 * ``{state, planning, goal}`` without ``part``; ``{planning}`` or ``{goal}`` with it.
 */
export interface SessionStateResponse {
  goal?: GoalState | null
  planning?: PlanningState | null
  state?: SessionRuntimeState | null
  [k: string]: unknown
}
export interface GoalState {
  bindingGeneration?: Bindinggeneration
  capabilities?: GoalCapabilities
  externalSessionId?: Externalsessionid
  freshness?: Freshness
  goal?: Goal | null
  lastOutcome?: Goal | null
  pendingOperationId?: Pendingoperationid
  revision?: Revision
  runtime: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
  sourceEpoch?: Sourceepoch
  sourceRevision?: Sourcerevision
}
export interface GoalCapabilities {
  actions?: Actions
  reason?: Reason
  supported?: Supported
  [k: string]: unknown
}
export interface Goal {
  createdAt: Createdat
  endedAt?: Endedat
  id: Id
  iterations?: Iterations
  lastReason?: Lastreason
  objective: Objective
  sourceTurnId?: Sourceturnid
  status: Status
  timeUsedSeconds?: Timeusedseconds
  tokenBudget?: Tokenbudget
  tokensUsed?: Tokensused
  updatedAt: Updatedat
}
export interface PlanningState {
  capabilities?: PlanningCapabilities
  draft?: PlanDraft | null
  effectiveMode?: Effectivemode
  epoch?: Epoch
  execution?: Execution
  executionProgress?: Executionprogress
  freshness?: Freshness1
  operation?: Operation
  proposal?: PlanDocument | null
  proposals?: Proposals
  requestedMode?: Requestedmode
  review?: PlanReview | null
  revision?: Revision3
  runtime: Runtime1
  runtimeId?: Runtimeid1
  sessionId: Sessionid1
}
export interface PlanningCapabilities {
  actions?: Actions1
  contentStreaming?: Contentstreaming
  reason?: Reason1
  supported?: Supported1
  [k: string]: unknown
}
export interface PlanDraft {
  content: Content
  contentState: Contentstate
  draftId: Draftid
  planId: Planid
  revision: Revision1
  seq: Seq
}
export interface PlanDocument {
  contentHash: Contenthash
  contentState?: Contentstate1
  createdAt?: Createdat1
  markdown: Markdown
  planId: Planid1
  revision: Revision2
  sourceTurnId?: Sourceturnid1
  title: Title
}
export interface PlanReview {
  actions?: Actions2
  contentHash: Contenthash1
  planId: Planid2
  planRevision: Planrevision
  reviewId: Reviewid
  status: Status1
}
export interface SessionRuntimeState {
  createdAt: Createdat2
  error?: Error
  externalSessionId?: Externalsessionid1
  metadata?: Metadata
  runtime: Runtime2
  selections?: Selections
  sessionId: Sessionid2
  status?: Status2
  statusReason?: Statusreason
  updatedAt: Updatedat1
  updatedSeq: Updatedseq
  [k: string]: unknown
}
export interface Metadata {
  [k: string]: unknown
}
export interface Selections {
  [k: string]: string | null
}
