import type { InboundNotificationMethod, RequestMethod } from './protocol.js'

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: RequestMethod
  params: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: InboundNotificationMethod
  params: Record<string, unknown>
}

export type InboundFrame = JsonRpcRequest | JsonRpcNotification

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: {
    code: number
    message: string
    data: BridgeErrorDataWire
  }
}

export interface BridgeErrorDataWire {
  code: string
  retryable: boolean
  sessionId?: string
  externalSessionId?: string
  details?: Record<string, unknown>
}

export interface BridgeRequestHandler {
  request(frame: JsonRpcRequest): Promise<unknown>
  notification(frame: JsonRpcNotification): Promise<void>
  disconnected(reason: string): Promise<void>
  fatal(error: Error): Promise<void>
}
