/** JSON-RPC request identifier accepted by bridge v1. */
export type JsonRpcId = string | number

/** Parsed JSON-RPC request. */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params: Record<string, unknown>
}

/** Parsed JSON-RPC notification. */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params: Record<string, unknown>
}

/** Parsed inbound bridge frame. */
export type InboundFrame = JsonRpcRequest | JsonRpcNotification

/** Successful JSON-RPC response. */
export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

/** Failed JSON-RPC response. */
export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: { code: number; message: string; data: Record<string, unknown> }
}
