/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact agent-catalog-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Description = string | null
export type Hidden = boolean
export type Id = string
export type Mode = "primary" | "subagent" | "all"
export type Name = string | null
export type Agents = ProtocolAgentItem[]
export type Revision = number
export type Runtime = "codex" | "claude" | "opencode" | "acp" | "dsh"
export type Servertime = string

export interface ProtocolAgentCatalogResponse {
  catalog: ProtocolAgentCatalog
  serverTime: Servertime
  [k: string]: unknown
}
export interface ProtocolAgentCatalog {
  agents: Agents
  revision: Revision
  runtime: Runtime
  [k: string]: unknown
}
export interface ProtocolAgentItem {
  description: Description
  hidden: Hidden
  id: Id
  mode: Mode
  name: Name
  [k: string]: unknown
}
