/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact permission-catalog.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Default = boolean
export type Description = string | null
export type Displayname = string
export type Id = string
export type Selectionid = string
export type Permissions = ProtocolPermissionItem[]
export type Revision = number
export type Runtime = "codex" | "claude" | "opencode" | "acp" | "dsh"

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
