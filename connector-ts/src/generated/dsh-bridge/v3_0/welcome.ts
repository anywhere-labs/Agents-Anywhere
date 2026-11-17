/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact welcome. Do not edit; run `yarn contracts:generate`. */

/**
 * Connector's single-line answer to hello (§1.3).
 */
export type DshBridgeHandshakeReply =
  | {
      t: "welcome"
      bridgeProtocol: string
      connectorInstance: string
      connectorVersion: string
    }
  | {
      t: "reject"
      code: "bad_key" | "unsupported_protocol" | "duplicate_host" | "busy"
      message: string
    }
