/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact content-request.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type Path = string

export interface ContentRequest {
  body?: Body
  method: Method
  path: Path
}
export interface Body {
  [k: string]: unknown
}
