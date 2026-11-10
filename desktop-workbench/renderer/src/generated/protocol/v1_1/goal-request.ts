/* eslint-disable */
/**
 * Generated from protocol 1.1 artifact goal-request.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Action = "set" | "edit" | "pause" | "resume" | "clear"
/**
 * @maxItems 100
 */
export type Attachments = {
  [k: string]: unknown
}[]
export type Expectedrevision = number
export type Objective = string | null
export type Operationid = string

export interface GoalRequest {
  action: Action
  attachments?: Attachments
  expectedRevision: Expectedrevision
  objective?: Objective
  operationId: Operationid
}
