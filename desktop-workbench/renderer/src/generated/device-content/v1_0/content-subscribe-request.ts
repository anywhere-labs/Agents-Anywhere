/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact content-subscribe-request.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Aftercursor = string | null
export type Fromseq = number | null
export type Sessionid = string
export type Stream = "session" | "terminal" | "trust"
export type Terminalid = string | null

export interface ContentSubscribeRequest {
  afterCursor?: Aftercursor
  fromSeq?: Fromseq
  sessionId?: Sessionid
  stream?: Stream
  terminalId?: Terminalid
}
