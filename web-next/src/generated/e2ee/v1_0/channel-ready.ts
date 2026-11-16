/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact channel-ready.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

/**
 * client_id_for(identity public key)
 */
export type Clientid = string
export type Deviceid = string
export type Directorykeyepoch = number
export type Directorykeyid = string
export type Kind = "ready"

/**
 * Device -> client, first transport message after KK (and after ``pair.committed``).
 * The client sends no request before it. The device re-checked policy and the grant.
 */
export interface ChannelReady {
  clientId: Clientid
  deviceId: Deviceid
  directoryKeyEpoch: Directorykeyepoch
  directoryKeyId: Directorykeyid
  kind?: Kind
  [k: string]: unknown
}
