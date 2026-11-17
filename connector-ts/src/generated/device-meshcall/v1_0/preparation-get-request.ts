/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact preparation-get-request. Do not edit; run `yarn contracts:generate`. */

export type Preparationid = string
export type Runtime = string | null
export type Runtimeid = string

/**
 * ``Sessions/workspacePreparationGet`` (critical lane).
 */
export interface PreparationGetRequest {
  preparationId: Preparationid
  runtime?: Runtime
  runtimeId: Runtimeid
  [k: string]: unknown
}
