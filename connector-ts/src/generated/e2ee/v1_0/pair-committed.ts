/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact pair-committed. Do not edit; run `yarn contracts:generate`. */

/**
 * client_id_for(identity public key)
 */
export type Clientid = string
export type Deviceid = string
export type Deviceid1 = string
export type Epoch = number
/**
 * 32 bytes, base64url without padding
 */
export type Key = string
export type Keyid = string
export type Grantedat = string
export type Kind = "pair.committed"

/**
 * Device -> client right after XXpsk0: the grant is on disk. If it is lost, the client
 * retries with KK; a successful KK proves the grant exists.
 */
export interface PairCommitted {
  clientId: Clientid
  deviceId: Deviceid
  directoryKey: DirectoryKeyGrant
  grantedAt: Grantedat
  kind?: Kind
  [k: string]: unknown
}
/**
 * Sent by the device to a client inside the channel after pairing or rotation.
 */
export interface DirectoryKeyGrant {
  deviceId: Deviceid1
  epoch: Epoch
  key: Key
  keyId: Keyid
  [k: string]: unknown
}
