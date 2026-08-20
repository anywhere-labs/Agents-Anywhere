/** Stable bridge error identifiers carried in JSON-RPC error data. */
export type BridgeErrorCode =
  | 'PARSE_ERROR'
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'INTERNAL_ERROR'
  | 'UNSUPPORTED_OPERATION'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CONFLICT'
  | 'SESSION_BINDING_CONFLICT'
  | 'INVALID_SELECTION'
  | 'INTERACTION_ALREADY_CLOSED'
  | 'REQUEST_TIMEOUT'
  | 'DSH_SERVICE_UNAVAILABLE'
  | 'PERSISTENCE_ERROR'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'SHUTTING_DOWN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_INITIALIZED'
  | 'FRAME_TOO_LARGE'
  | 'DSH_CONCURRENT_WRITER_DETECTED'
  | 'COMMAND_NOT_FOUND'

const JSON_RPC_CODES: Readonly<Record<BridgeErrorCode, number>> = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNSUPPORTED_OPERATION: -32001,
  SESSION_NOT_FOUND: -32002,
  SESSION_CONFLICT: -32003,
  SESSION_BINDING_CONFLICT: -32003,
  DSH_CONCURRENT_WRITER_DETECTED: -32003,
  INVALID_SELECTION: -32004,
  INTERACTION_ALREADY_CLOSED: -32005,
  REQUEST_TIMEOUT: -32006,
  DSH_SERVICE_UNAVAILABLE: -32007,
  PERSISTENCE_ERROR: -32008,
  PROTOCOL_VERSION_MISMATCH: -32009,
  SHUTTING_DOWN: -32010,
  IDEMPOTENCY_CONFLICT: -32011,
  NOT_INITIALIZED: -32012,
  FRAME_TOO_LARGE: -32013,
  COMMAND_NOT_FOUND: -32014,
}

/** Safe optional error metadata exposed across the process boundary. */
export interface BridgeErrorData {
  code: BridgeErrorCode
  retryable: boolean
  sessionId?: string
  externalSessionId?: string
  details?: string | {
    ownership: 'borrowed'
    selectionKind: 'model'
  } | {
    operation: 'workspace-attach'
    workspacePath: string
  }
}

/** Error whose public fields are safe to serialize to the Connector. */
export class BridgeError extends Error {
  readonly rpcCode: number
  readonly data: BridgeErrorData

  /**
   * Create a public bridge failure.
   * @param code - Stable bridge error identifier.
   * @param message - Prompt-free public description.
   * @param data - Optional safe metadata.
   */
  constructor(
    code: BridgeErrorCode,
    message: string,
    data: Omit<BridgeErrorData, 'code'> = { retryable: false },
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'BridgeError'
    this.rpcCode = JSON_RPC_CODES[code]
    this.data = { code, ...data }
  }
}

/** Convert an unknown failure to a redacted public bridge error. */
export function publicError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error
  if (error instanceof Error && (error.name === 'AbortError' || error.message === 'request cancelled by Connector')) {
    return new BridgeError('REQUEST_TIMEOUT', 'The bridge request was cancelled.', { retryable: true })
  }
  if (error instanceof Error && [
    'SessionFormatUnsupportedError',
    'SessionPersistenceCorruptionError',
  ].includes(error.name)) {
    return new BridgeError('PERSISTENCE_ERROR', 'The DSH Session could not be read safely.', { retryable: false })
  }
  return new BridgeError('INTERNAL_ERROR', 'The bridge could not complete the request.', { retryable: false })
}
