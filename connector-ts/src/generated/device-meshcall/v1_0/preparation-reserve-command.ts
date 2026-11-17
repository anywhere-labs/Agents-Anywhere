/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact preparation-reserve-command. Do not edit; run `yarn contracts:generate`. */

export type Catalogrevision = number
export type Configuration = {
  [k: string]: string | boolean
} | null
export type Createoperationid = string
export type Expectedrevision = number
export type Mode = "plan"
export type Operationid = string
export type Platformsessionid = string
export type Preparationid = string
export type Runtime = string | null
export type Runtimeid = string

/**
 * ``workspace.preparation.reserve``: hold a ready preparation for one creation.
 */
export interface PreparationReserveCommand {
  catalogRevision: Catalogrevision
  configuration?: Configuration
  createOperationId: Createoperationid
  expectedRevision: Expectedrevision
  planningIntent?: PlanningCreationIntent | null
  platformSessionId: Platformsessionid
  preparationId: Preparationid
  runtime?: Runtime
  runtimeId: Runtimeid
  selections?: Selections
  [k: string]: unknown
}
export interface PlanningCreationIntent {
  mode: Mode
  operationId: Operationid
}
export interface Selections {
  [k: string]: string | null
}
