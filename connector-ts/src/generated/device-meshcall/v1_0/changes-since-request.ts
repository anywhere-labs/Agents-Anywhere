/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact changes-since-request. Do not edit; run `yarn contracts:generate`. */

export type Afterseq = number
export type Bytebudget = number
export type Limit = number
export type Sessionid = string

export interface ChangesSinceRequest {
  afterSeq: Afterseq
  byteBudget?: Bytebudget
  limit?: Limit
  sessionId: Sessionid
  [k: string]: unknown
}
