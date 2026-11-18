/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact trust-list-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Deviceid = string
export type Directorykeyepoch = number
export type Directorykeyid = string
/**
 * client_id_for(identity public key)
 */
export type Clientid = string
export type Grantedat = string
export type Grantedby = "qr" | "approval" | "local"
export type Identitypubfingerprint = string
export type Label = string
export type Platform = ("web" | "desktop" | "android" | "ios" | "cli" | "agent") | null
export type Revokedat = string | null
export type Grants = ClientGrantView[]

/**
 * ``GET /e2ee/v1/trust``.
 */
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
  platform?: Platform
  revokedAt?: Revokedat
  [k: string]: unknown
}
