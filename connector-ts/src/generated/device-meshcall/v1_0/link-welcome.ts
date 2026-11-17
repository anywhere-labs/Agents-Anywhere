/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact link-welcome. Do not edit; run `yarn contracts:generate`. */

export type Connectionid = string
export type Contractversion = "1.0"
export type Channelswitches = {
  [k: string]: unknown
}[]
export type Runtimes = {
  [k: string]: unknown
}[]
export type E2Eemode = "off" | "required"
export type Expiresat = string
/**
 * always the deviceId
 */
export type Instanceid = string
export type Maxframebytes = number
export type Routerurl = string
/**
 * services the token grants
 */
export type Services = string[]
export type Token = string
export type Tokenid = string
/**
 * equals clientMessageId/operationId when the client supplied one
 */
export type Commandid = string
export type Deadline = string
/**
 * Client-computed digest of the plaintext input; the Server only compares it
 */
export type Inputdigest = string | null
export type M = string
export type Pendingcommands = PendingCommand[]
export type Serverversion = string

/**
 * Response to ``/device/hello``. Issuing it revokes the device's previous Mesh token.
 */
export interface LinkWelcome {
  connectionId: Connectionid
  contractVersion: Contractversion
  desired?: DesiredState
  e2eeMode?: E2Eemode
  mesh: MeshCredentials
  pendingCommands?: Pendingcommands
  seqFloors?: Seqfloors
  serverVersion: Serverversion
  [k: string]: unknown
}
export interface DesiredState {
  channelSwitches?: Channelswitches
  deviceSettings?: Devicesettings
  runtimes?: Runtimes
  [k: string]: unknown
}
export interface Devicesettings {
  [k: string]: unknown
}
/**
 * Where and how the device registers its services; the token may register only ``instanceId``.
 */
export interface MeshCredentials {
  expiresAt: Expiresat
  instanceId: Instanceid
  maxFrameBytes?: Maxframebytes
  routerUrl: Routerurl
  services?: Services
  token: Token
  tokenId: Tokenid
  [k: string]: unknown
}
/**
 * A command the Server still waits on, replayed in ``LinkWelcome.pendingCommands``.
 */
export interface PendingCommand {
  commandId: Commandid
  deadline: Deadline
  inputDigest?: Inputdigest
  m: M
  p?: P
  [k: string]: unknown
}
export interface P {
  [k: string]: unknown
}
/**
 * sessionId -> max(head_seq, seq_ceiling); the device clock must restart above it
 */
export interface Seqfloors {
  [k: string]: number
}
