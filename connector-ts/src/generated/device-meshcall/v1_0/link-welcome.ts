/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact link-welcome. Do not edit; run `yarn contracts:generate`. */

export type Connectionid = string
export type Contractversion = "1.0"
export type Active = boolean
export type Config = {
  [k: string]: unknown
} | null
export type Authtoken = string
export type Baseurl = string
export type Model = string | null
export type Protocol = string
export type Name = string | null
export type Operationid = string | null
export type Revision = number
export type Runtimeid = string
export type Runtimetype = string
export type Switchrevision = number | null
export type Channelswitches = ChannelSwitchCommand[]
export type Active1 = boolean
export type Config1 = {
  [k: string]: unknown
} | null
export type Name1 = string | null
export type Operationid1 = string | null
export type Revision1 = number
export type Runtimeid1 = string
export type Runtimetype1 = string
export type Switchrevision1 = number | null
export type Runtimes = RuntimeApplyCommand[]
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
/**
 * ``channel.switch``: ``runtime.apply`` fenced by the switch the Server is executing
 * (``operationId``, ``switchRevision``; sent when the device declared ``channelReconcileFence``).
 */
export interface ChannelSwitchCommand {
  active: Active
  config?: Config
  modelGateway?: ModelGateway | null
  name?: Name
  operationId?: Operationid
  revision?: Revision
  runtimeId: Runtimeid
  runtimeType: Runtimetype
  switchRevision?: Switchrevision
  [k: string]: unknown
}
/**
 * The model gateway a Runtime instance uses, as the device takes it (the Server keeps it in the config).
 */
export interface ModelGateway {
  authToken: Authtoken
  baseUrl: Baseurl
  model?: Model
  protocol: Protocol
  [k: string]: unknown
}
export interface Devicesettings {
  [k: string]: unknown
}
/**
 * ``runtime.apply``: one desired Runtime instance; also the item of ``LinkWelcome.desired.runtimes``.
 *
 * ``config`` holds only the instance's own settings, validated against its type's ``configSchema``
 * (Runtime Control 2.1); a model gateway travels as ``modelGateway``. ``revision`` only grows, so a late
 * command never undoes a newer one.
 */
export interface RuntimeApplyCommand {
  active: Active1
  config?: Config1
  modelGateway?: ModelGateway | null
  name?: Name1
  operationId?: Operationid1
  revision?: Revision1
  runtimeId: Runtimeid1
  runtimeType: Runtimetype1
  switchRevision?: Switchrevision1
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
