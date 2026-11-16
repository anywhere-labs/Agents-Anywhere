/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact port-closed-event.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Deviceid = string
export type Port = number

export interface PortClosedEvent {
  deviceId: Deviceid
  port: Port
  [k: string]: unknown
}
