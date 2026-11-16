/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact client-grant-view. Do not edit; run `yarn contracts:generate`. */

/**
 * client_id_for(identity public key)
 */
export type Clientid = string
export type Grantedat = string
export type Grantedby = "qr" | "approval" | "local"
export type Identitypubfingerprint = string
export type Label = string
export type Platform = ("web" | "desktop" | "android" | "ios" | "cli") | null
export type Revokedat = string | null

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
