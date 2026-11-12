/* eslint-disable */
/**
 * Generated from protocol 1.2 artifact interaction-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Actionid = string
export type Interactionid = string
export type Ownergeneration = string
export type Requestrevision = number
export type Responseoperationid = string

export interface WorkflowInteractionResponse {
  actionId: Actionid
  input?: Input
  interactionId: Interactionid
  ownerGeneration: Ownergeneration
  requestRevision: Requestrevision
  responseOperationId: Responseoperationid
}
export interface Input {
  [k: string]: unknown
}
