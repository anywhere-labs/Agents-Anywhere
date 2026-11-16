/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact preview-open-command.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Frptoken = string
export type Frpsaddr = string
export type Port = number
export type Previewid = string
export type Slug = string
export type Tokenexpiresat = string

/**
 * Server -> device ``cmd`` ``preview.open``.
 */
export interface PreviewOpenCommand {
  frpToken: Frptoken
  frpsAddr: Frpsaddr
  port: Port
  previewId: Previewid
  slug: Slug
  tokenExpiresAt: Tokenexpiresat
  [k: string]: unknown
}
