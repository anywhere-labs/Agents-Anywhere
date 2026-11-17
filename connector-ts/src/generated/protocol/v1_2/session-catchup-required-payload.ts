/* eslint-disable */
/** Generated from contracts/protocol/1.2 artifact session-catchup-required-payload. Do not edit; run `yarn contracts:generate`. */

export type Reason = "device_reconnected" | "subscription_restored"
export type Sessionid = string

/**
 * Payload of ``session.catchup_required``: refetch ``/events`` with your own cursor.
 */
export interface SessionCatchupRequiredPayload {
  reason: Reason
  sessionId: Sessionid
  [k: string]: unknown
}
