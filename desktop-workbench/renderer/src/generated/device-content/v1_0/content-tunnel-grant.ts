/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact content-tunnel-grant.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Connectionid = string
export type Credential = string
export type E2EKey = string
export type ExpiresAtUnixMs = number
export type InstanceId = string
export type Maxframebytes = number
export type RouterUrl = string
export type TunnelId = string

export interface ContentTunnelGrant {
  connectionId: Connectionid
  credential: Credential
  e2e_key: E2EKey
  expires_at_unix_ms: ExpiresAtUnixMs
  instance_id: InstanceId
  maxFrameBytes: Maxframebytes
  router_url: RouterUrl
  tunnel_id: TunnelId
}
