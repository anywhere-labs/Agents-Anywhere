/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact changes-since-response. Do not edit; run `yarn contracts:generate`. */

export type Complete = boolean
export type Cursor = string
export type Emittedat = string
export type Eventid = string
export type Protocolversion = "1.0" | "1.1"
export type Sequence = number
export type Sessionid = string
export type Type = string
export type Events = ProtocolEventEnvelope[]
export type Resetseq = number
export type Snapshotrequired = boolean
export type Toseq = number

export interface ChangesSinceResponse {
  complete: Complete
  events?: Events
  resetSeq: Resetseq
  snapshotRequired?: Snapshotrequired
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
