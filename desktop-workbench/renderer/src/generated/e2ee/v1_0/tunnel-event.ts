/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact tunnel-event.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Kind = "event"

/**
 * A realtime client event (same envelope as normal mode) pushed through the channel.
 */
export interface TunnelEvent {
  event: Event
  kind?: Kind
  [k: string]: unknown
}
export interface Event {
  [k: string]: unknown
}
