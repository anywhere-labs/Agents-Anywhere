/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact hello. Do not edit; run `yarn contracts:generate`. */

/**
 * First line the plugin sends after dialing (§1.3).
 */
export interface DshBridgeHello {
  t: "hello"
  bridgeProtocol: string
  key: string
  hostInstance: string
  hostKind: "desktop" | "web" | "headless" | "unknown"
  dshVersion: string
  pluginVersion: string
  dshHome?: string
}
