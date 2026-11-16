/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact pairing-client-hello.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Appversion = string | null
export type Label = string
export type Platform = "web" | "desktop" | "android" | "ios" | "cli"

/**
 * Payload of XXpsk0 message 3 (client -> device).
 */
export interface PairingClientHello {
  appVersion?: Appversion
  label: Label
  platform: Platform
  [k: string]: unknown
}
