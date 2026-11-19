/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact content-pair-result. Do not edit; run `yarn contracts:generate`. */

export type Clientid = string
export type Deviceid = string
export type Epoch = number
/**
 * 32 bytes, base64url without padding
 */
export type Key = string
export type Keyid = string
export type Grantedat = string

export interface ContentPairResult {
  clientId: Clientid
  directoryKey: DirectoryKeyGrant
  grantedAt: Grantedat
}
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
