/* eslint-disable */
/**
 * Generated from protocol 1.1 artifact goal-state.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

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
