/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact event-envelope.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Cursor = string
export type Emittedat = string
export type Eventid = string
export type Protocolversion = "1.0"
export type Sequence = number
export type Sessionid = string
export type Type = string

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
