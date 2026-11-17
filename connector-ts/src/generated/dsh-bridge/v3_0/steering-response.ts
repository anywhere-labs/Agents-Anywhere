/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact steering-response. Do not edit; run `yarn contracts:generate`. */

/**
 * _session/steering result (§8).
 */
export interface DshSteeringResponse {
  outcome: "injected" | "promptRequired" | "failed"
  message?: string
}
