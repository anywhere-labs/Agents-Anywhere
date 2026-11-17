/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact runtime-status-event. Do not edit; run `yarn contracts:generate`. */

export type Capabilities = {
  [k: string]: unknown
} | null
export type Runtimeid = string

export interface RuntimeStatusEvent {
  capabilities?: Capabilities
  runtimeId: Runtimeid
  status?: Status
  [k: string]: unknown
}
export interface Status {
  [k: string]: unknown
}
