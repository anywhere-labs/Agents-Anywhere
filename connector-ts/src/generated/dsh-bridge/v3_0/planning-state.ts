/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact planning-state. Do not edit; run `yarn contracts:generate`. */

/**
 * _dsh/planning/get and /set result (§10).
 */
export interface DshPlanningState {
  available: boolean
  active?: boolean
  pending?: boolean
  outcome?: "committed" | "queued" | "cancelled" | "noop"
}
