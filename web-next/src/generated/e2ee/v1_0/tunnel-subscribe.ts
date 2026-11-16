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
/**
 * required when stream is session
 */
export type Sessionid = string | null
export type Stream = "session" | "terminal"
/**
 * required when stream is terminal
 */
export type Terminalid = string | null

/**
 * Same as opening a realtime WebSocket in normal mode.
 *
 * ``stream: "session"``: the session WebSocket of ``sessionId`` (events after ``afterCursor`` are replayed
 * first). ``stream: "terminal"``: the stream of device terminal ``terminalId``
 * (``/api/v2/connectors/{deviceId}/terminals-v2/{terminalId}/stream`` in normal mode); every
 * ``TunnelEvent.event`` is one message of that WebSocket, and input, resize and close stay ``request``s to the
 * same paths as normal mode.
 */
export interface TunnelSubscribe {
  afterCursor?: Aftercursor
  id: Id
  kind?: Kind
  sessionId?: Sessionid
  stream?: Stream
  terminalId?: Terminalid
  [k: string]: unknown
}
