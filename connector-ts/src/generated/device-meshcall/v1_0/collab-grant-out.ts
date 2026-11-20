/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact collab-grant-out. Do not edit; run `yarn contracts:generate`. */

export type At = string
export type Grantid = string
export type State = "active" | "revoked"
export type Supervisorsessionid = string

/**
 * ``collab.grant.changed``: a collaboration grant issued or revoked for a supervisor session; the Server
 * revokes the delegation tokens of a revoked grant.
 */
export interface CollabGrantOut {
  at: At
  grantId: Grantid
  state: State
  supervisorSessionId: Supervisorsessionid
  [k: string]: unknown
}
