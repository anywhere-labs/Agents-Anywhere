/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact client-call-item. Do not edit; run `yarn contracts:generate`. */

/**
 * Item of ``Client/call``: one ``head``, then the body's ``chunk``s.
 */
export type ClientCallItem = ClientCallHead | ClientCallChunk
export type Commandid = string
export type Code = string
export type Message = string
export type Retryable = boolean
export type Outcome = "accepted" | "rejected"
export type Contenttype = string
export type Kind = "head"
export type Status = number
/**
 * at most 524288 UTF-8 bytes
 */
export type Chunk =
  | {
      [k: string]: unknown
    }
  | string
export type End = boolean
export type Kind1 = "chunk"
export type Seq = number

/**
 * First item of ``Client/call``: the HTTP status the client gets.
 */
export interface ClientCallHead {
  command?: ClientCommandOutcome | null
  contentType?: Contenttype
  kind: Kind
  status: Status
  [k: string]: unknown
}
/**
 * How the device settled the command; the Server settles its receipt from it.
 */
export interface ClientCommandOutcome {
  commandId: Commandid
  e?: LinkError | null
  outcome: Outcome
  [k: string]: unknown
}
export interface LinkError {
  code: Code
  message?: Message
  retryable?: Retryable
  [k: string]: unknown
}
/**
 * Later items: the body, JSON text split into pieces of at most ``MAX_CHUNK_BYTES`` (``end`` on the last).
 */
export interface ClientCallChunk {
  chunk: Chunk
  end?: End
  kind: Kind1
  seq: Seq
  [k: string]: unknown
}
