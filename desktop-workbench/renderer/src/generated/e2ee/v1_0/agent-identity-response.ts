/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact agent-identity-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Deviceid = string
/**
 * 32 bytes, base64url without padding
 */
export type Identitypub = string
export type Label = string

/**
 * ``GET /e2ee/v1/agent-identity`` (served by the supervisor's device): the public key its collaboration
 * client uses to open channels to other devices. A trusted client relays it to the target device's
 * ``trust/approve`` with ``platform: "agent"``.
 */
export interface AgentIdentityResponse {
  deviceId: Deviceid
  identityPub: Identitypub
  label: Label
  [k: string]: unknown
}
