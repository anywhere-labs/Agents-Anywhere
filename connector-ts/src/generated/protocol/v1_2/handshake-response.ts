/* eslint-disable */
/** Generated from contracts/protocol/1.2 artifact handshake-response. Do not edit; run `yarn contracts:generate`. */

export type Selectedprotocolversion = "1.0" | "1.1" | "1.2"
export type Serverversion = string

export interface ProtocolHandshakeResponse {
  selectedProtocolVersion: Selectedprotocolversion
  serverVersion: Serverversion
  [k: string]: unknown
}
