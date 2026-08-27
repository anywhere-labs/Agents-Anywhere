/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact agent-preset-catalog-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Agentpreset = string
export type Default = boolean
export type Description = string | null
export type Disabledreason = string | null
export type Displayname = string
export type Enabled = boolean
export type Id = string
export type Presets = ProtocolAgentPresetItem[]
export type Revision = number
export type Runtime = "codex" | "claude" | "opencode" | "acp" | "dsh"
export type Servertime = string

export interface ProtocolAgentPresetCatalogResponse {
  catalog: ProtocolAgentPresetCatalog
  serverTime: Servertime
  [k: string]: unknown
}
export interface ProtocolAgentPresetCatalog {
  presets: Presets
  revision: Revision
  runtime: Runtime
  [k: string]: unknown
}
export interface ProtocolAgentPresetItem {
  agentPreset: Agentpreset
  default: Default
  description: Description
  disabledReason: Disabledreason
  displayName: Displayname
  enabled: Enabled
  id: Id
  metadata: Metadata
  [k: string]: unknown
}
export interface Metadata {
  [k: string]: unknown
}
