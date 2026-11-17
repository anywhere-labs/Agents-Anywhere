/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact runtime-apply-command. Do not edit; run `yarn contracts:generate`. */

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

/**
 * ``runtime.apply``: one desired Runtime instance; also the item of ``LinkWelcome.desired.runtimes``.
 *
 * ``config`` holds only the instance's own settings, validated against its type's ``configSchema``
 * (Runtime Control 2.1); a model gateway travels as ``modelGateway``. ``revision`` only grows, so a late
 * command never undoes a newer one.
 */
export interface RuntimeApplyCommand {
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
