/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact client-grant-view. Do not edit; run `yarn contracts:generate`. */

export type Clientid = string
export type Grantedat = string
export type Grantedby = "qr" | "approval" | "local"
export type Identitypubfingerprint = string
export type Label = string
export type Revokedat = string | null

export interface ClientGrantView {
  clientId: Clientid
  grantedAt: Grantedat
  grantedBy: Grantedby
  identityPubFingerprint: Identitypubfingerprint
  label: Label
  revokedAt?: Revokedat
  [k: string]: unknown
}
