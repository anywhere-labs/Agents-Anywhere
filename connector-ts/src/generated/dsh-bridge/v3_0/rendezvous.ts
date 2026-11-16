/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact rendezvous. Do not edit; run `yarn contracts:generate`. */

/**
 * ~/.agents-anywhere/dsh-bridge/connector-acp.json (§1).
 */
export interface DshBridgeRendezvous {
  version: 3
  protocol: "acp"
  instanceId: string
  pid: number
  endpoint:
    | {
        unixPath: string
      }
    | {
        pipe: string
      }
  key: string
}
