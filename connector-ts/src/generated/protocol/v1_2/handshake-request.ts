/* eslint-disable */
/** Generated from contracts/protocol/1.2 artifact handshake-request. Do not edit; run `yarn contracts:generate`. */

export type Connectorversion = string
/**
 * @minItems 1
 */
export type Protocolversions = [string, ...string[]]
export type Runtime = string
export type Runtimeversion = string
export type Runtimes = ProtocolRuntimeIdentity[]

export interface ProtocolHandshakeRequest {
  connectorVersion: Connectorversion
  protocolVersions: Protocolversions
  runtimes?: Runtimes
  [k: string]: unknown
}
export interface ProtocolRuntimeIdentity {
  runtime: Runtime
  runtimeVersion: Runtimeversion
  [k: string]: unknown
}
