/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact tunnel-request.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Id = string
export type Kind = "request"
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
/**
 * client API path, e.g. /api/v2/sessions/{id}/snapshot, or /e2ee/v1/…
 */
export type Path = string

/**
 * Plaintext inside the channel: the same client API call as normal mode.
 */
export interface TunnelRequest {
  body?: Body
  id: Id
  kind?: Kind
  method: Method
  path: Path
  [k: string]: unknown
}
export interface Body {
  [k: string]: unknown
}
