/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact creation-get-request. Do not edit; run `yarn contracts:generate`. */

export type Createoperationid = string
export type Runtime = string | null
export type Runtimeid = string

/**
 * ``Sessions/creationGet`` (critical lane).
 */
export interface CreationGetRequest {
  createOperationId: Createoperationid
  runtime?: Runtime
  runtimeId: Runtimeid
  [k: string]: unknown
}
