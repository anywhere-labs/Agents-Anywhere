/* eslint-disable */
/**
 * Generated from protocol 1.2 artifact message-author.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Deviceid = string | null
export type Kind = "agent" | "supervision"
/**
 * the supervisor session the Agent acts for
 */
export type Sessionid = string | null
export type Supervisionid = string | null

/**
 * ``content.author`` of a user message that a person did not type: an Agent acting through the
 * collaboration tools, or a supervision wake (a digest the device sent to the supervisor).
 */
export interface MessageAuthor {
  deviceId: Deviceid
  kind: Kind
  sessionId: Sessionid
  supervisionId: Supervisionid
  [k: string]: unknown
}
