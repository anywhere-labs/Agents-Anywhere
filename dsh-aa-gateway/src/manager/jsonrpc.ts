/**
 * Minimal JSON-RPC 2.0 error wrapper for the Connector CLI RPC client.
 *
 * Distinct from `BridgeError` (which is specific to the dsh-aa-bridge Loopback
 * protocol) because the Connector CLI's error schema is owned by the Python
 * side, not the dsh bridge.
 */

export class JsonRpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'JsonRpcError'
    this.code = code
    this.data = data
  }
}