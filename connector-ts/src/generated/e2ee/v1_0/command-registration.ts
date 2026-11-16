/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact command-registration. Do not edit; run `yarn contracts:generate`. */

export type Commandid = string
export type Deviceid = string
export type Inputdigest = string

/**
 * Plaintext side-channel so the Server can keep idempotency for encrypted commands.
 */
export interface CommandRegistration {
  commandId: Commandid
  deviceId: Deviceid
  inputDigest: Inputdigest
  [k: string]: unknown
}
