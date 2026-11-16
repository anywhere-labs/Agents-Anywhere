/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact outbox-ack. Do not edit; run `yarn contracts:generate`. */

export type Oid = number

/**
 * Cumulative: everything up to and including ``oid`` may be deleted.
 */
export interface OutboxAck {
  oid: Oid
  [k: string]: unknown
}
