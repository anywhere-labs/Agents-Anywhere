/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-command. Do not edit; run `yarn contracts:generate`. */

export type Runtime = string | null
export type Runtimeid = string | null
export type Sessionid = string

/**
 * A command on one session; ``runtime``/``runtimeId`` name the instance when the Server knows it.
 */
export interface SessionCommand {
  runtime?: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
  [k: string]: unknown
}
