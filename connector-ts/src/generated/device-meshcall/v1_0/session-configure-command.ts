/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-configure-command. Do not edit; run `yarn contracts:generate`. */

export type Expectedrevision = number
export type Operationid = string
export type Runtime = string | null
export type Runtimeid = string | null
export type Sessionid = string

/**
 * ``session.configuration.update``: Agent options by id, applied only while ``expectedRevision`` is current.
 */
export interface SessionConfigureCommand {
  expectedRevision: Expectedrevision
  operationId: Operationid
  runtime?: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
  values: Values
  [k: string]: unknown
}
export interface Values {
  [k: string]: string | boolean
}
