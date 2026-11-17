/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-state-request. Do not edit; run `yarn contracts:generate`. */

export type Part = ("planning" | "goal") | null
export type Sessionid = string

/**
 * ``Sessions/state``: the runtime state with both parts, or only ``part``.
 */
export interface SessionStateRequest {
  part?: Part
  sessionId: Sessionid
  [k: string]: unknown
}
