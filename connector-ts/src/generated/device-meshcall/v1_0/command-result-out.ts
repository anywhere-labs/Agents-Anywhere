/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact command-result-out. Do not edit; run `yarn contracts:generate`. */

export type Commandid = string
export type Code = string
export type Message = string
export type Retryable = boolean
export type Outcome = "accepted" | "rejected"
export type R = {
  [k: string]: unknown
} | null

export interface CommandResultOut {
  commandId: Commandid
  e?: LinkError | null
  outcome: Outcome
  r?: R
  [k: string]: unknown
}
export interface LinkError {
  code: Code
  message?: Message
  retryable?: Retryable
  [k: string]: unknown
}
