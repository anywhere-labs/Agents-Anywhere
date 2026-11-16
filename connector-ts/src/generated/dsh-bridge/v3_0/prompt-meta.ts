/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact prompt-meta. Do not edit; run `yarn contracts:generate`. */

/**
 * session/prompt and _session/steering request _meta.dsh (§8).
 */
export interface DshPromptMeta {
  requestId: string
  delivery?: "turn" | "queue"
  selections?: {
    model?: string
    reasoningEffort?: string
    permission?: string
    agentPreset?: string
  }
}
