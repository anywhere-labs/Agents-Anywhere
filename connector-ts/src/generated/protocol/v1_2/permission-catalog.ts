/* eslint-disable */
/** Generated from contracts/protocol/1.2 artifact permission-catalog. Do not edit; run `yarn contracts:generate`. */

export type Default = boolean
export type Description = string | null
export type Displayname = string
export type Id = string
export type Selectionid = string
export type Permissions = ProtocolPermissionItem[]
export type Revision = number
export type Runtime = string

export interface ProtocolPermissionCatalog {
  permissions?: Permissions
  revision: Revision
  runtime: Runtime
  [k: string]: unknown
}
export interface ProtocolPermissionItem {
  default?: Default
  description?: Description
  displayName: Displayname
  id: Id
  metadata?: Metadata
  selectionId: Selectionid
  [k: string]: unknown
}
export interface Metadata {
  [k: string]: unknown
}
