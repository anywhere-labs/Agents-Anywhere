/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact revoke-client-request.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

/**
 * client_id_for(identity public key)
 */
export type Clientid = string

/**
 * ``POST /e2ee/v1/trust/revoke``.
 */
export interface RevokeClientRequest {
  clientId: Clientid
  [k: string]: unknown
}
