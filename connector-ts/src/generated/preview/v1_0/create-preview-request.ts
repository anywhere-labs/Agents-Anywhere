/* eslint-disable */
/** Generated from contracts/preview/1.0 artifact create-preview-request. Do not edit; run `yarn contracts:generate`. */

export type Deviceid = string
export type Port = number
export type Sessionid = string | null
export type Ttlhours = number | null
export type Visibility = "private" | "link"

export interface CreatePreviewRequest {
  deviceId: Deviceid
  port: Port
  sessionId?: Sessionid
  ttlHours?: Ttlhours
  visibility?: Visibility
  [k: string]: unknown
}
