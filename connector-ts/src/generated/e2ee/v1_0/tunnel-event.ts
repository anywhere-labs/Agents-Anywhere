/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact tunnel-event. Do not edit; run `yarn contracts:generate`. */

export type Kind = "event"
export type Sub = string | null

/**
 * A realtime client event (same envelope as normal mode) pushed through the channel.
 *
 * ``sub`` names the subscription it belongs to; channel-level events (``e2ee.*``) have none.
 */
export interface TunnelEvent {
  event: Event
  kind?: Kind
  sub?: Sub
  [k: string]: unknown
}
export interface Event {
  [k: string]: unknown
}
