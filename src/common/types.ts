/**
 * Placeholder shared types for dsh-aa-connector. The connector Host ↔ Client
 * wire contract, process lifecycle DTO, and pairing protocol schemas will live
 * here once the Connector CLI integration lands. Right now the plugin only
 * exposes the in-process Bridge and a blank settings surface.
 */

export const PLUGIN_NAMESPACE = 'dsh-aa-connector'
export const BRIDGE_DESCRIPTOR_FILENAME = 'endpoint.json'

/** Stable identity used by the bridge locator discovery file. */
export interface BridgeEndpoint {
  readonly version: 1
  readonly host: '127.0.0.1'
  readonly port: number
  readonly token: string
  readonly pid: number
}