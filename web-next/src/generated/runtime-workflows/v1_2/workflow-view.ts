/* eslint-disable */
/**
 * Generated from protocol 1.2 artifact workflow-view.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Connectorid = string
export type Id = string
export type Kind = "preparation" | "creation"
export type Projectid = string
export type Protocolversion = "1.1" | "1.2"
export type Runtimeid = string
export type Sessionid = string | null
export type Default = boolean
export type Description = string | null
export type Displayname = string
export type Displayname1 = string
export type Id1 = string
export type Itemdisplayname = string | null
export type Id2 = string
export type Default1 = boolean
export type Description1 = string | null
export type Displayname2 = string
export type Fullmodelid = string | null
export type Id3 = string
export type Selectionid = string
export type Reasoningitems = ProtocolReasoningItem[]
export type Selectionid1 = string | null
export type Models = ProtocolModelItem[]
export type Revision = number
export type Runtime = string

export interface WorkflowView {
  connectorId: Connectorid
  id: Id
  kind: Kind
  projectId: Projectid
  protocolVersion?: Protocolversion
  runtimeId: Runtimeid
  sessionId?: Sessionid
  state: WorkflowState
}
/**
 * Keep runtime extensions while validating the shared model catalog.
 */
export interface WorkflowState {
  catalog?: ProtocolModelCatalog | null
  [k: string]: unknown
}
export interface ProtocolModelCatalog {
  models: Models
  revision: Revision
  runtime: Runtime
  [k: string]: unknown
}
export interface ProtocolModelItem {
  default: Default
  description: Description
  displayName: Displayname
  group: ProtocolModelGroup | null
  id: Id2
  metadata: Metadata
  reasoningItems: Reasoningitems
  selectionId: Selectionid1
  [k: string]: unknown
}
/**
 * Where a model is routed from, e.g. a DSH provider or relay.
 */
export interface ProtocolModelGroup {
  displayName: Displayname1
  id: Id1
  itemDisplayName: Itemdisplayname
  [k: string]: unknown
}
export interface Metadata {
  [k: string]: unknown
}
export interface ProtocolReasoningItem {
  default: Default1
  description: Description1
  displayName: Displayname2
  fullModelId: Fullmodelid
  id: Id3
  metadata: Metadata1
  selectionId: Selectionid
  [k: string]: unknown
}
export interface Metadata1 {
  [k: string]: unknown
}
