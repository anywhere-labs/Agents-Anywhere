/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact agent-meta. Do not edit; run `yarn contracts:generate`. */

/**
 * initialize result _meta.dsh, also the params of _dsh/host/features (§2).
 */
export interface DshAgentMeta {
  bridgeProtocol: string
  hostInstance: string
  dshVersion: string
  features: {
    queue: boolean
    steer: boolean
    continue: boolean
    planning: boolean
    questions: boolean
    attachments: boolean
    fileUploads: boolean
    agentPresets: boolean
    permissionPresets: boolean
  }
}
