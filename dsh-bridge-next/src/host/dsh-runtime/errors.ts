import { record } from './types.js'

const codes = {
  PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603, UNSUPPORTED_OPERATION: -32001,
  SESSION_NOT_FOUND: -32002, REQUEST_TIMEOUT: -32006, DSH_SERVICE_UNAVAILABLE: -32007,
  PERSISTENCE_ERROR: -32008, PROTOCOL_VERSION_MISMATCH: -32009,
  NOT_INITIALIZED: -32012, FRAME_TOO_LARGE: -32013,
} as const

export class BridgeError extends Error {
  constructor(readonly code: keyof typeof codes, message: string, readonly retryable = false) {
    super(message)
  }
  toJSON() {
    return { code: codes[this.code], message: this.message, data: { code: this.code, retryable: this.retryable } }
  }
}

export function publicError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error
  const nativeCode = record(error).code
  if (nativeCode === 'SESSION_QUERY_SESSION_NOT_FOUND') {
    return new BridgeError('SESSION_NOT_FOUND', 'The DSH session no longer exists.')
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new BridgeError('REQUEST_TIMEOUT', 'The read was cancelled.', true)
  }
  // Never serialize native exception messages: a parser error can contain prompts or credentials.
  return new BridgeError('PERSISTENCE_ERROR', 'DSH could not safely read this session. Check the DSH host log.')
}
