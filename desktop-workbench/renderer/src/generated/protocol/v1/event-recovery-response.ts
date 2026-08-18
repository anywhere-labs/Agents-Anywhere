/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact event-recovery-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Cursor = string
export type Emittedat = string
export type Eventid = string
export type Protocolversion = "1.0"
export type Sequence = number
export type Sessionid = string
export type Type = string
export type Events = ProtocolEventEnvelope[]
export type Nextcursor = string
export type Servertime = string
export type Snapshotrequired = boolean

export interface ProtocolEventRecoveryResponse {
  events: Events
  nextCursor: Nextcursor
  serverTime: Servertime
  snapshotRequired: Snapshotrequired
  [k: string]: unknown
}
export interface ProtocolEventEnvelope {
  cursor: Cursor
  emittedAt: Emittedat
  eventId: Eventid
  payload: Payload
  protocolVersion: Protocolversion
  sequence: Sequence
  sessionId: Sessionid
  type: Type
  [k: string]: unknown
}
export interface Payload {
  [k: string]: unknown
}
