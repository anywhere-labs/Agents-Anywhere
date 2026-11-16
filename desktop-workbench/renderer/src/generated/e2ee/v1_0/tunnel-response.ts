/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact tunnel-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Id = string
export type Kind = "response"
export type Status = number

export interface TunnelResponse {
  body?: Body
  id: Id
  kind?: Kind
  status: Status
  [k: string]: unknown
}
export interface Body {
  [k: string]: unknown
}
