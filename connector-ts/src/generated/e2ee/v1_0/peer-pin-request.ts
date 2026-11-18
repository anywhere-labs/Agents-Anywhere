/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact peer-pin-request. Do not edit; run `yarn contracts:generate`. */

export type Deviceid = string
/**
 * 32 bytes, base64url without padding
 */
export type Deviceidentitypub = string
export type Label = string

/**
 * ``POST /e2ee/v1/peers/pin`` (served by the supervisor's device): a trusted client that pinned the target
 * device's key hands it over, so the collaboration client can open a KK channel to it.
 */
export interface PeerPinRequest {
  deviceId: Deviceid
  deviceIdentityPub: Deviceidentitypub
  label?: Label
  [k: string]: unknown
}
