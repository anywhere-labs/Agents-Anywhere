/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact capability-set.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Allowed = boolean
export type Available = boolean
export type Capabilityid = string
export type Runtime = ("codex" | "claude" | "opencode" | "acp") | null
export type Scope = "adapter" | "runtime" | "session"
export type Sessionid = string | null
export type Supported = boolean
export type Unavailablereason = string | null
export type Version = string
export type Capabilities = ProtocolCapability[]
export type Revision = number

export interface ProtocolCapabilitySet {
  capabilities?: Capabilities
  revision: Revision
  [k: string]: unknown
}
export interface ProtocolCapability {
  allowed?: Allowed
  available?: Available
  capabilityId: Capabilityid
  parameters?: Parameters
  runtime?: Runtime
  scope?: Scope
  sessionId?: Sessionid
  supported?: Supported
  unavailableReason?: Unavailablereason
  version?: Version
  [k: string]: unknown
}
export interface Parameters {
  [k: string]: unknown
}
