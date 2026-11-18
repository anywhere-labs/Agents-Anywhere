/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-recover-command. Do not edit; run `yarn contracts:generate`. */

export type Cliexited = boolean
export type Expectedgeneration = string
export type Operationid = string
export type Runtime = string | null
export type Runtimeid = string | null
export type Sessionid = string
export type Sourcerevision = string | null

/**
 * ``session.recover``: reopens an Agent session the Agent lost, now instead of on the next message.
 */
export interface SessionRecoverCommand {
  cliExited?: Cliexited
  expectedGeneration: Expectedgeneration
  operationId: Operationid
  runtime?: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
  sourceRevision?: Sourcerevision
  [k: string]: unknown
}
