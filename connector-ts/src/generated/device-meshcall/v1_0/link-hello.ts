/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact link-hello. Do not edit; run `yarn contracts:generate`. */

export type Capabilities = string[]
export type Connectorversion = string
/**
 * @minItems 1
 */
export type Contractversions = ["1.0", ..."1.0"[]]
export type Deviceid = string
export type Host = "desktop" | "cli" | "dsh-plugin"
export type Meshe2Eekey = string | null
export type Os = string
export type Headseq = number
export type Resetseq = number
export type Sessionid = string
export type Sessionshead = SessionHead[]

/**
 * ``POST /api/v3/device/hello`` (device credentials in the HTTP headers).
 */
export interface LinkHello {
  capabilities?: Capabilities
  connectorVersion: Connectorversion
  contractVersions: Contractversions
  deviceId: Deviceid
  host: Host
  meshE2eeKey?: Meshe2Eekey
  os: Os
  sessionsHead?: Sessionshead
  [k: string]: unknown
}
export interface SessionHead {
  headSeq: Headseq
  resetSeq: Resetseq
  sessionId: Sessionid
  [k: string]: unknown
}
