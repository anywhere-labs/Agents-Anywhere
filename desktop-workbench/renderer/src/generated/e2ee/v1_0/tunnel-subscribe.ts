/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact tunnel-subscribe.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

/**
 * seq:N; events after it are replayed first
 */
export type Aftercursor = string | null
export type Id = string
export type Kind = "subscribe"
export type Sessionid = string
export type Stream = "session"

/**
 * Same as opening the session WebSocket in normal mode, for one session.
 */
export interface TunnelSubscribe {
  afterCursor?: Aftercursor
  id: Id
  kind?: Kind
  sessionId: Sessionid
  stream?: Stream
  [k: string]: unknown
}
