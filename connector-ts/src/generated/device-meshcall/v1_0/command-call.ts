/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact command-call. Do not edit; run `yarn contracts:generate`. */

/**
 * equals clientMessageId/operationId when the client supplied one
 */
export type Commandid = string
export type Deadline = string
/**
 * Client-computed digest of the plaintext input; the Server only compares it
 */
export type Inputdigest = string | null

/**
 * Request of every ``Commands/*`` call: a state-changing intent with a durable receipt.
 */
export interface CommandCall {
  commandId: Commandid
  deadline: Deadline
  inputDigest?: Inputdigest
  p?: P
  [k: string]: unknown
}
export interface P {
  [k: string]: unknown
}
