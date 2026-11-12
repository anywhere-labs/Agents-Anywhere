/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact plan-document.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Contenthash = string
export type Contentstate = "ready"
export type Createdat = string | null
export type Markdown = string
export type Planid = string
export type Revision = number
export type Sourceturnid = string | null
export type Title = string

export interface PlanDocument {
  contentHash: Contenthash
  contentState?: Contentstate
  createdAt?: Createdat
  markdown: Markdown
  planId: Planid
  revision: Revision
  sourceTurnId?: Sourceturnid
  title: Title
}
