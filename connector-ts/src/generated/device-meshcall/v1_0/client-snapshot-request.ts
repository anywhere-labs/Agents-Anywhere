/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact client-snapshot-request. Do not edit; run `yarn contracts:generate`. */

export type Bytebudget = number
export type Limit = number
export type Sessionid = string

export interface ClientSnapshotRequest {
  byteBudget?: Bytebudget
  limit?: Limit
  sessionId: Sessionid
  [k: string]: unknown
}
