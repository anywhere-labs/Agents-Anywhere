/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact command-ack. Do not edit; run `yarn contracts:generate`. */

export type Code = string
export type Message = string
export type Retryable = boolean
export type Outcome = "accepted" | "rejected"
export type R = {
  [k: string]: unknown
} | null

/**
 * Response of a ``Commands/*`` call. ``accepted`` only after the device committed it to disk.
 *
 * ``unknown`` never travels: the Server derives it from transport errors after the call opened.
 */
export interface CommandAck {
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
