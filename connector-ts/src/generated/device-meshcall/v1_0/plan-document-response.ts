/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact plan-document-response. Do not edit; run `yarn contracts:generate`. */

export type Contenthash = string
export type Contentstate = "ready"
export type Createdat = string | null
export type Markdown = string
export type Planid = string
export type Revision = number
export type Sourceturnid = string | null
export type Title = string
export type Plans = PlanDocument[] | null

export interface PlanDocumentResponse {
  document?: PlanDocument | null
  plans?: Plans
  [k: string]: unknown
}
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
