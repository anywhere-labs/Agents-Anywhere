/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact runtime-catalogs-response. Do not edit; run `yarn contracts:generate`. */

export type Commands = SlashCommand[] | null
export type Description = string | null
export type Inputhint = string | null
export type Name = string
export type Default = boolean
export type Description1 = string | null
export type Displayname = string
export type Displayname1 = string
export type Id = string
export type Itemdisplayname = string | null
export type Id1 = string
export type Default1 = boolean
export type Description2 = string | null
export type Displayname2 = string
export type Fullmodelid = string | null
export type Id2 = string
export type Selectionid = string
export type Reasoningitems = ProtocolReasoningItem[]
export type Selectionid1 = string | null
export type Models = ProtocolModelItem[]
export type Revision = number
export type Runtime = string
export type Default2 = boolean
export type Description3 = string | null
export type Displayname3 = string
export type Id3 = string
export type Selectionid2 = string
export type Permissions = ProtocolPermissionItem[]
export type Revision1 = number
export type Runtime1 = string
export type Selections = {
  [k: string]: unknown
} | null
export type Sessionid = string

/**
 * ``Runtime/catalogs``: ``catalogs`` is empty while the session is not open on the device.
 */
export interface RuntimeCatalogsResponse {
  catalogs?: SessionCatalogs
  sessionId: Sessionid
  [k: string]: unknown
}
/**
 * A session's catalogs: models, permissions, slash commands and the current selections.
 */
export interface SessionCatalogs {
  commands?: Commands
  models?: ProtocolModelCatalog | null
  permissions?: ProtocolPermissionCatalog | null
  selections?: Selections
  [k: string]: unknown
}
export interface SlashCommand {
  description?: Description
  inputHint?: Inputhint
  name: Name
  [k: string]: unknown
}
export interface ProtocolModelCatalog {
  models?: Models
  revision: Revision
  runtime: Runtime
  [k: string]: unknown
}
export interface ProtocolModelItem {
  default?: Default
  description?: Description1
  displayName: Displayname
  group?: ProtocolModelGroup | null
  id: Id1
  metadata?: Metadata
  reasoningItems?: Reasoningitems
  selectionId?: Selectionid1
  [k: string]: unknown
}
/**
 * Where a model is routed from, e.g. a DSH provider or relay.
 */
export interface ProtocolModelGroup {
  displayName: Displayname1
  id: Id
  itemDisplayName?: Itemdisplayname
  [k: string]: unknown
}
export interface Metadata {
  [k: string]: unknown
}
export interface ProtocolReasoningItem {
  default?: Default1
  description?: Description2
  displayName: Displayname2
  fullModelId?: Fullmodelid
  id: Id2
  metadata?: Metadata1
  selectionId: Selectionid
  [k: string]: unknown
}
export interface Metadata1 {
  [k: string]: unknown
}
export interface ProtocolPermissionCatalog {
  permissions?: Permissions
  revision: Revision1
  runtime: Runtime1
  [k: string]: unknown
}
export interface ProtocolPermissionItem {
  default?: Default2
  description?: Description3
  displayName: Displayname3
  id: Id3
  metadata?: Metadata2
  selectionId: Selectionid2
  [k: string]: unknown
}
export interface Metadata2 {
  [k: string]: unknown
}
