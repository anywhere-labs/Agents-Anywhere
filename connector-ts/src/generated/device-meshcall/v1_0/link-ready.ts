/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact link-ready. Do not edit; run `yarn contracts:generate`. */

export type Connectionid = string

/**
 * ``POST /api/v3/device/ready`` once the services are registered; the Server then opens
 * ``Link/attach`` and ``Link/outbox``. Presence is the Server-held ``attach`` stream.
 */
export interface LinkReady {
  connectionId: Connectionid
  [k: string]: unknown
}
