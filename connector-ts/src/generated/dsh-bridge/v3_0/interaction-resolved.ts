/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact interaction-resolved. Do not edit; run `yarn contracts:generate`. */

/**
 * _dsh/interaction/resolved notification params (§10).
 */
export interface DshInteractionResolved {
  sessionId: string
  interactionId: string
  by: "dsh" | "timeout" | "cancelled"
  optionId?: string
}
