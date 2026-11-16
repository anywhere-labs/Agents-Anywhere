/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact directory-key-grant. Do not edit; run `yarn contracts:generate`. */

export type Deviceid = string
export type Epoch = number
/**
 * base64url without padding
 */
export type Key = string
export type Keyid = string

/**
 * Sent by the device to a client inside the channel after pairing or rotation.
 */
export interface DirectoryKeyGrant {
  deviceId: Deviceid
  epoch: Epoch
  key: Key
  keyId: Keyid
  [k: string]: unknown
}
