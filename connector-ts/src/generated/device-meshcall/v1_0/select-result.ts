/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact select-result. Do not edit; run `yarn contracts:generate`. */

export type Applied = boolean | null
export type Externalsessionid = string | null
export type Selections = {
  [k: string]: unknown
} | null
export type Sessionid = string | null
export type Createdat = string
export type Error = {
  [k: string]: unknown
} | null
export type Externalsessionid1 = string | null
export type Runtime = string
export type Sessionid1 = string
export type Status = "idle" | "waiting" | "pending" | "running" | "stopping" | "waiting_approval" | "error" | "blocked"
export type Statusreason = string | null
export type Updatedat = string
export type Updatedseq = number
export type Updated = boolean | null

export interface SelectResult {
  applied?: Applied
  externalSessionId?: Externalsessionid
  selections?: Selections
  sessionId?: Sessionid
  state?: SessionRuntimeState | null
  updated?: Updated
  [k: string]: unknown
}
export interface SessionRuntimeState {
  createdAt: Createdat
  error?: Error
  externalSessionId?: Externalsessionid1
  metadata?: Metadata
  runtime: Runtime
  selections?: Selections1
  sessionId: Sessionid1
  status?: Status
  statusReason?: Statusreason
  updatedAt: Updatedat
  updatedSeq: Updatedseq
  [k: string]: unknown
}
export interface Metadata {
  [k: string]: unknown
}
export interface Selections1 {
  [k: string]: string | null
}
