/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact preparation-respond-command. Do not edit; run `yarn contracts:generate`. */

export type Actionid = string
export type Interactionid = string
export type Ownergeneration = string
export type Preparationid = string
export type Requestrevision = number
export type Responseoperationid = string
export type Runtime = string | null
export type Runtimeid = string

/**
 * ``workspace.preparation.respond``: an answer to an open request of the preparation.
 */
export interface PreparationRespondCommand {
  actionId: Actionid
  input?: Input
  interactionId: Interactionid
  ownerGeneration: Ownergeneration
  preparationId: Preparationid
  requestRevision: Requestrevision
  responseOperationId: Responseoperationid
  runtime?: Runtime
  runtimeId: Runtimeid
  [k: string]: unknown
}
export interface Input {
  [k: string]: unknown
}
