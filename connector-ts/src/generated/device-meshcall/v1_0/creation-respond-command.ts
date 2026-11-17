/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact creation-respond-command. Do not edit; run `yarn contracts:generate`. */

export type Actionid = string
export type Createoperationid = string
export type Interactionid = string
export type Ownergeneration = string
export type Requestrevision = number
export type Responseoperationid = string
export type Runtime = string | null
export type Runtimeid = string

/**
 * ``session.creation.respond``: an answer to an open request of the creation.
 */
export interface CreationRespondCommand {
  actionId: Actionid
  createOperationId: Createoperationid
  input?: Input
  interactionId: Interactionid
  ownerGeneration: Ownergeneration
  requestRevision: Requestrevision
  responseOperationId: Responseoperationid
  runtime?: Runtime
  runtimeId: Runtimeid
  [k: string]: unknown
}
export interface Input {
  [k: string]: unknown
}
