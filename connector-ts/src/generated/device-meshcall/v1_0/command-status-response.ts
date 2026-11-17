/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact command-status-response. Do not edit; run `yarn contracts:generate`. */

export type Commandid = string
export type Code = string
export type Message = string
export type Retryable = boolean
export type Known = boolean
export type Outcome = ("accepted" | "rejected" | "unknown") | null
export type R = {
  [k: string]: unknown
} | null

export interface CommandStatusResponse {
  commandId: Commandid
  e?: LinkError | null
  known: Known
  outcome?: Outcome
  r?: R
  [k: string]: unknown
}
export interface LinkError {
  code: Code
  message?: Message
  retryable?: Retryable
  [k: string]: unknown
}
