/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact content-result. Do not edit; run `yarn contracts:generate`. */

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
