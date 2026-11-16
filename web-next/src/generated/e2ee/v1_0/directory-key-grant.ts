/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact directory-key-grant.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Deviceid = string
export type Epoch = number
/**
 * 32 bytes, base64url without padding
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
