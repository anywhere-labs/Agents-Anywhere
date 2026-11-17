/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-watch-request. Do not edit; run `yarn contracts:generate`. */

export type Afterseq = number
export type Sessionid = string

/**
 * ``Sessions/watch``: opening the stream subscribes, cancelling it unsubscribes.
 */
export interface SessionWatchRequest {
  afterSeq: Afterseq
  sessionId: Sessionid
  [k: string]: unknown
}
