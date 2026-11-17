/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact runtime-apply-result. Do not edit; run `yarn contracts:generate`. */

export type Allowed = boolean
export type Available = boolean
export type Capabilityid = string
export type Runtime = string | null
export type Scope = "runtime" | "session"
export type Sessionid = string | null
export type Supported = boolean
export type Unavailablereason = string | null
export type Version = string
export type Capabilities = ProtocolCapability[]
export type Revision = number
export type Code = string
export type Message = string
export type Retryable = boolean
export type Instanceid = string | null
export type Modelconnection = {
  [k: string]: unknown
} | null
export type Revision1 = number | null
export type Runtimeid = string
export type Stale = boolean | null
export type Status = string

/**
 * The instance after ``runtime.apply`` / ``channel.switch``.
 */
export interface RuntimeApplyResult {
  capabilities?: ProtocolCapabilitySet | null
  error?: LinkError | null
  instanceId?: Instanceid
  modelConnection?: Modelconnection
  revision?: Revision1
  runtimeId: Runtimeid
  stale?: Stale
  status: Status
  [k: string]: unknown
}
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
export interface LinkError {
  code: Code
  message?: Message
  retryable?: Retryable
  [k: string]: unknown
}
