/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-request. Do not edit; run `yarn contracts:generate`. */

export type Sessionid = string

/**
 * Request of a read scoped to one session (``Sessions/notices``, ``capabilities``, ``queue``, …).
 */
export interface SessionRequest {
  sessionId: Sessionid
  [k: string]: unknown
}
