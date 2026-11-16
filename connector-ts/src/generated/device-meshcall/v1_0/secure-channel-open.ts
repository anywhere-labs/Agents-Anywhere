/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact secure-channel-open. Do not edit; run `yarn contracts:generate`. */

export type Ch = string
export type Clientid = string

/**
 * Request of the duplex ``Secure/channel``: one call per client channel.
 */
export interface SecureChannelOpen {
  ch: Ch
  clientId: Clientid
  [k: string]: unknown
}
