/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact handshake-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Selectedprotocolversion = "1.0"
export type Serverversion = string

export interface ProtocolHandshakeResponse {
  selectedProtocolVersion: Selectedprotocolversion
  serverVersion: Serverversion
  [k: string]: unknown
}
