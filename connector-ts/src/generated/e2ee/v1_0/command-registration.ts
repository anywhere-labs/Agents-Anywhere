/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact command-registration. Do not edit; run `yarn contracts:generate`. */

export type Commandid = string
export type Deviceid = string
export type Inputdigest = string

/**
 * ``POST /api/v3/e2ee/commands`` before the command goes through the channel, so the Server
 * keeps idempotency for encrypted commands. ``inputDigest`` is keyed (see ``input_digest``):
 * the Server can compare it but cannot confirm a guessed input.
 */
export interface CommandRegistration {
  commandId: Commandid
  deviceId: Deviceid
  inputDigest: Inputdigest
  [k: string]: unknown
}
