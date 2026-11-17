/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact display-envelope. Do not edit; run `yarn contracts:generate`. */

export type Keyid = string | null
export type Mode = "plain" | "sealed"
export type Payload =
  | {
      [k: string]: unknown
    }
  | string

/**
 * Human-facing content the Server stores but never reads.
 *
 * ``plain``: ``payload`` is a JSON object (normal mode).
 * ``sealed``: ``payload`` is base64 ciphertext encrypted with the device's
 * directory key identified by ``keyId`` (E2EE mode).
 */
export interface DisplayEnvelope {
  keyId?: Keyid
  mode: Mode
  payload: Payload
  [k: string]: unknown
}
