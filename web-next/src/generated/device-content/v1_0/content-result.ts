/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact content-result.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Contenttype = string | null
export type Status = number

export interface ContentResult {
  body?: Body
  contentType?: Contenttype
  status: Status
}
export interface Body {
  [k: string]: unknown
}
