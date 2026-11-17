/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact revoke-client-request. Do not edit; run `yarn contracts:generate`. */

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
