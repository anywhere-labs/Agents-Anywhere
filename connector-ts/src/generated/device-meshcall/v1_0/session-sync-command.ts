/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-sync-command. Do not edit; run `yarn contracts:generate`. */

export type Archived = boolean | null
export type Runtime = string | null
export type Runtimeid = string | null
export type Sessionid = string
export type Takeover = boolean | null

/**
 * ``session.sync``: a Server-owned fact of the session the device keeps a copy of.
 */
export interface SessionSyncCommand {
  archived?: Archived
  runtime?: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
  takeover?: Takeover
  [k: string]: unknown
}
