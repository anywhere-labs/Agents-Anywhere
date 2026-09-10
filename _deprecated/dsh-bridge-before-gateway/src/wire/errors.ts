import type { BridgeErrorDataWire } from './types.js'

export const DECLARED_RPC_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNSUPPORTED_OPERATION: -32001,
  SESSION_NOT_FOUND: -32002,
  SESSION_CONFLICT: -32003,
  INVALID_SELECTION: -32004,
  INTERACTION_ALREADY_CLOSED: -32005,
  REQUEST_TIMEOUT: -32006,
  DSH_SERVICE_UNAVAILABLE: -32007,
  PERSISTENCE_ERROR: -32008,
  PROTOCOL_VERSION_MISMATCH: -32009,
  SHUTTING_DOWN: -32010,
  IDEMPOTENCY_CONFLICT: -32011,
  NOT_INITIALIZED: -32012,
} as const

export type DeclaredBridgeErrorCode = keyof typeof DECLARED_RPC_CODES

export class BridgeError extends Error {
  readonly rpcCode: number
  readonly data: BridgeErrorDataWire

  constructor(
    code: DeclaredBridgeErrorCode,
    message: string,
    data: Omit<BridgeErrorDataWire, 'code'> = { retryable: false },
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'BridgeError'
    this.rpcCode = DECLARED_RPC_CODES[code]
    this.data = { code, ...data }
  }
}

export function publicError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new BridgeError('REQUEST_TIMEOUT', 'The bridge request was cancelled.', { retryable: true })
  }
  return new BridgeError('INTERNAL_ERROR', 'The bridge could not complete the request.', {
    retryable: false,
  }, { cause: error })
}
