/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact secure-channel-item. Do not edit; run `yarn contracts:generate`. */

/**
 * base64 Noise transport message
 */
export type Ct = string
export type N = number

/**
 * Noise transport message in either direction; ``n`` is the per-direction counter.
 */
export interface SecureChannelItem {
  ct: Ct
  n: N
  [k: string]: unknown
}
