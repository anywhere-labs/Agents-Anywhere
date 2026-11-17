/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact store-read-request. Do not edit; run `yarn contracts:generate`. */

export type Bytebudget = number
export type Cursor = number | null
export type Limit = number
export type Mode = "latest" | "before" | "after"
export type Sessionid = string

export interface StoreReadRequest {
  byteBudget?: Bytebudget
  cursor?: Cursor
  limit?: Limit
  mode: Mode
  sessionId: Sessionid
  [k: string]: unknown
}
