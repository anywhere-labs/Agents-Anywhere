/* eslint-disable */
/** Generated from contracts/preview/1.0 artifact preview-list-response. Do not edit; run `yarn contracts:generate`. */

export type Closereason = ("port_closed" | "user_closed" | "expired" | "device_offline" | "revoked") | null
export type Deviceid = string
export type Expiresat = string
/**
 * true in E2EE mode: preview traffic is not end-to-end encrypted
 */
export type Plaintextnotice = boolean
export type Port = number
export type Previewid = string
export type Sessionid = string | null
export type Slug = string
export type State = "opening" | "open" | "closed"
export type Url = string | null
export type Visibility = "private" | "link"
export type Previews = PreviewView[]

export interface PreviewListResponse {
  previews: Previews
  [k: string]: unknown
}
export interface PreviewView {
  closeReason: Closereason
  deviceId: Deviceid
  expiresAt: Expiresat
  plaintextNotice: Plaintextnotice
  port: Port
  previewId: Previewid
  sessionId: Sessionid
  slug: Slug
  state: State
  url: Url
  visibility: Visibility
  [k: string]: unknown
}
