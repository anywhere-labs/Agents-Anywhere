/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact port-listening-event.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Deviceid = string
export type Pid = number | null
export type Port = number
export type Processname = string | null
export type Sessionid = string | null
export type Url = string | null
export type Ports = ListeningPort[]

/**
 * Device ``evt`` ``port.listening``.
 */
export interface PortListeningEvent {
  deviceId: Deviceid
  ports?: Ports
  [k: string]: unknown
}
export interface ListeningPort {
  pid?: Pid
  port: Port
  processName?: Processname
  sessionId?: Sessionid
  url?: Url
  [k: string]: unknown
}
