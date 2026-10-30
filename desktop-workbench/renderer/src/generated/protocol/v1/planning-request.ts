/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact planning-request.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

/**
 * @maxItems 100
 */
export type Attachments = {
  [k: string]: unknown
}[]
export type Command =
  "enter_plan" | "exit_plan" | "submit_task" | "approve_and_execute" | "request_revision" | "dismiss_review"
export type Content = string | null
export type Contenthash = string | null
export type Epoch = string | null
export type Expectedrevision = number | null
export type Feedback = string | null
export type Operationid = string
export type Planid = string | null
export type Planrevision = number | null
export type Reviewid = string | null

export interface PlanningRequest {
  attachments?: Attachments
  command: Command
  content?: Content
  contentHash?: Contenthash
  epoch?: Epoch
  expectedRevision?: Expectedrevision
  feedback?: Feedback
  operationId: Operationid
  planId?: Planid
  planRevision?: Planrevision
  reviewId?: Reviewid
}
