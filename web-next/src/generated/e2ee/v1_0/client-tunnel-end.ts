/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact client-tunnel-end.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Code =
  | "closed"
  | "e2ee_not_paired"
  | "pairing_expired"
  | "e2ee_handshake_failed"
  | "e2ee_protocol_error"
  | "too_large"
  | "connector_offline"
  | "e2ee_required"
export type Ch = string
/**
 * client_id_for(identity public key)
 */
export type Clientid = string
export type Deviceid = string
export type T = "end"

/**
 * Ends one channel on ``WS /api/v3/tunnel``.
 *
 * Server -> client: the device ended its ``Secure/channel`` call (``code`` is the call's error code) or the
 * device went offline. Client -> Server: cancel the call. The Server cannot forge anything worse than a
 * disconnect with it: a client never relaxes encryption because of an ``end``.
 */
export interface ClientTunnelEnd {
  code?: Code
  route: TunnelRoute
  t: T
}
export interface TunnelRoute {
  ch: Ch
  clientId: Clientid
  deviceId: Deviceid
  [k: string]: unknown
}
