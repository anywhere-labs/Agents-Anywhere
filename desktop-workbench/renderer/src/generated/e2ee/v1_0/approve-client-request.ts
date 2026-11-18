/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact approve-client-request.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

/**
 * 32 bytes, base64url without padding
 */
export type Clientidentitypub = string
export type Label = string
export type Platform = ("web" | "desktop" | "android" | "ios" | "cli" | "agent") | null

/**
 * ``POST /e2ee/v1/trust/approve``: an authorised client asks the device to trust another
 * client's key (§7.2). The device confirms locally unless its policy allows otherwise.
 */
export interface ApproveClientRequest {
  clientIdentityPub: Clientidentitypub
  label: Label
  platform?: Platform
  [k: string]: unknown
}
