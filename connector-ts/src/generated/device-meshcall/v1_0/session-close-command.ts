/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-close-command. Do not edit; run `yarn contracts:generate`. */

export type Closeoperationid = string | null
export type Ownergeneration = string
export type Runtime = string | null
export type Runtimeid = string | null
export type Sessionid = string

/**
 * ``session.close``: releases the Agent session (its native record stays); the next operation reopens it.
 */
export interface SessionCloseCommand {
  closeOperationId?: Closeoperationid
  ownerGeneration: Ownergeneration
  runtime?: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
  [k: string]: unknown
}
