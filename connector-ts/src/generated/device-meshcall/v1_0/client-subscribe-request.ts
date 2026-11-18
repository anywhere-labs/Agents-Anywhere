/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact client-subscribe-request. Do not edit; run `yarn contracts:generate`. */

export type Deviceid = string
export type Grantid = string
export type Sessionid = string
export type Clientid = string | null
export type Platform = string | null
export type Userid = string
export type Fromseq = number
export type Stream = "terminal"
export type Terminalid = string

/**
 * ``Client/subscribe``: opening subscribes, cancelling unsubscribes. Input, resize and close are
 * ``Client/call`` requests to the same paths as the client's.
 */
export interface ClientSubscribeRequest {
  caller?: ClientCaller | null
  fromSeq?: Fromseq
  stream: Stream
  terminalId: Terminalid
  [k: string]: unknown
}
/**
 * Who sent the request, as the Server authenticated it.
 */
export interface ClientCaller {
  agent?: AgentCaller | null
  clientId?: Clientid
  platform?: Platform
  userId: Userid
  [k: string]: unknown
}
/**
 * The supervisor session a delegated request acts for (``ClientCaller.agent``).
 */
export interface AgentCaller {
  deviceId: Deviceid
  grantId: Grantid
  sessionId: Sessionid
  [k: string]: unknown
}
