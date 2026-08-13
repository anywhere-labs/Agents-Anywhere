/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact model-catalog.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Default = boolean
export type Description = string | null
export type Displayname = string
export type Id = string
export type Default1 = boolean
export type Description1 = string | null
export type Displayname1 = string
export type Fullmodelid = string | null
export type Id1 = string
export type Selectionid = string
export type Reasoningitems = ProtocolReasoningItem[]
export type Selectionid1 = string | null
export type Models = ProtocolModelItem[]
export type Revision = number
export type Runtime = string

export interface ProtocolModelCatalog {
  models?: Models
  revision: Revision
  runtime: Runtime
  [k: string]: unknown
}
export interface ProtocolModelItem {
  default?: Default
  description?: Description
  displayName: Displayname
  id: Id
  metadata?: Metadata
  reasoningItems?: Reasoningitems
  selectionId?: Selectionid1
  [k: string]: unknown
}
export interface Metadata {
  [k: string]: unknown
}
export interface ProtocolReasoningItem {
  default?: Default1
  description?: Description1
  displayName: Displayname1
  fullModelId?: Fullmodelid
  id: Id1
  metadata?: Metadata1
  selectionId: Selectionid
  [k: string]: unknown
}
export interface Metadata1 {
  [k: string]: unknown
}
