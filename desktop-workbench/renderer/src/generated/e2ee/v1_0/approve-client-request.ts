/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact approve-client-request.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

/**
 * base64url without padding
 */
export type Clientidentitypub = string
export type Label = string

/**
 * An authorised client asks the device to trust another client's key.
 */
export interface ApproveClientRequest {
  clientIdentityPub: Clientidentitypub
  label: Label
  [k: string]: unknown
}
