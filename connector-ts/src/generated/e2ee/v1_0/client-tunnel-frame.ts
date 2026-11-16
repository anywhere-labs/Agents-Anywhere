/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact client-tunnel-frame. Do not edit; run `yarn contracts:generate`. */

/**
 * base64 Noise transport message
 */
export type Ct = string
export type N = number
export type Ch = string
export type Clientid = string
export type Deviceid = string
export type T = "tun"

/**
 * Client <-> Server frame on ``WS /api/v3/tunnel``; ``ct`` is opaque to the Server.
 */
export interface ClientTunnelFrame {
  ct: Ct
  n: N
  route: TunnelRoute
  t: T
}
export interface TunnelRoute {
  ch: Ch
  clientId: Clientid
  deviceId: Deviceid
  [k: string]: unknown
}
