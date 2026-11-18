/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact peer-list-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Deviceid = string
export type Identitypubfingerprint = string
export type Label = string
export type Pinnedat = string
export type Peers = PeerView[]

/**
 * ``GET /e2ee/v1/peers`` / response of ``POST /e2ee/v1/peers/pin``: devices the collaboration client pinned.
 */
export interface PeerListResponse {
  peers?: Peers
  [k: string]: unknown
}
export interface PeerView {
  deviceId: Deviceid
  identityPubFingerprint: Identitypubfingerprint
  label: Label
  pinnedAt: Pinnedat
  [k: string]: unknown
}
