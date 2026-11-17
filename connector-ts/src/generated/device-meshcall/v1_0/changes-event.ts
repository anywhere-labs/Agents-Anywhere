/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact changes-event. Do not edit; run `yarn contracts:generate`. */

export type Cursor = string
export type Emittedat = string
export type Eventid = string
export type Protocolversion = "1.0" | "1.1"
export type Sequence = number
export type Sessionid = string
export type Type = string
export type Events = ProtocolEventEnvelope[]
export type Fromseq = number
export type Resetseq = number
export type Sessionid1 = string
export type Toseq = number

/**
 * Item of ``Sessions/watch``: client-shaped events for a watched session.
 */
export interface ChangesEvent {
  events?: Events
  fromSeq: Fromseq
  resetSeq: Resetseq
  sessionId: Sessionid1
  toSeq: Toseq
  [k: string]: unknown
}
export interface ProtocolEventEnvelope {
  cursor: Cursor
  emittedAt: Emittedat
  eventId: Eventid
  payload?: Payload
  protocolVersion?: Protocolversion
  sequence: Sequence
  sessionId: Sessionid
  type: Type
  [k: string]: unknown
}
export interface Payload {
  [k: string]: unknown
}
