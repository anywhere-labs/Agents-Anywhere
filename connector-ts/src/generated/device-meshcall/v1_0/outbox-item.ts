/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact outbox-item. Do not edit; run `yarn contracts:generate`. */

export type M = string
export type Oid = number

/**
 * Persistent outbox message; every ``Link/outbox`` open resends from the lowest unacknowledged ``oid``.
 */
export interface OutboxItem {
  m: M
  oid: Oid
  p?: P
  [k: string]: unknown
}
export interface P {
  [k: string]: unknown
}
