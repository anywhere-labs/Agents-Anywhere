/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact content-pair-request.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Clientidentitypub = string
export type Clientsecret = string
export type Label = string
export type Pairingid = string
export type Pairingsecret = string
export type Platform = "android" | "ios" | "web" | "desktop" | "cli"

export interface ContentPairRequest {
  clientIdentityPub: Clientidentitypub
  clientSecret: Clientsecret
  label: Label
  pairingId: Pairingid
  pairingSecret: Pairingsecret
  platform: Platform
}
