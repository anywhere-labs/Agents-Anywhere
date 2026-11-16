/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact tunnel-event. Do not edit; run `yarn contracts:generate`. */

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
