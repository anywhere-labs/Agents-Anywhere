/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact trust-list-response. Do not edit; run `yarn contracts:generate`. */

export type Deviceid = string
export type Directorykeyepoch = number
export type Directorykeyid = string
export type Clientid = string
export type Grantedat = string
export type Grantedby = "qr" | "approval" | "local"
export type Identitypubfingerprint = string
export type Label = string
export type Revokedat = string | null
export type Grants = ClientGrantView[]

export interface TrustListResponse {
  deviceId: Deviceid
  directoryKeyEpoch: Directorykeyepoch
  directoryKeyId: Directorykeyid
  grants?: Grants
  [k: string]: unknown
}
export interface ClientGrantView {
  clientId: Clientid
  grantedAt: Grantedat
  grantedBy: Grantedby
  identityPubFingerprint: Identitypubfingerprint
  label: Label
  revokedAt?: Revokedat
  [k: string]: unknown
}
