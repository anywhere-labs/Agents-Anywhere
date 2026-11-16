/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact link-attach-item. Do not edit; run `yarn contracts:generate`. */

export type Kind = "heartbeat" | "event"
export type M = string | null

/**
 * Item on ``Link/attach``: a heartbeat every 20 s, or a lossy event (``EVENT_METHODS`` minus ``changes``).
 */
export interface LinkAttachItem {
  kind: Kind
  m?: M
  p?: P
  [k: string]: unknown
}
export interface P {
  [k: string]: unknown
}
