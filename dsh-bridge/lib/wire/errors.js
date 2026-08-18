const JSON_RPC_CODES = {
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
};
/** Error whose public fields are safe to serialize to the Connector. */
export class BridgeError extends Error {
    rpcCode;
    data;
    /**
     * Create a public bridge failure.
     * @param code - Stable bridge error identifier.
     * @param message - Prompt-free public description.
     * @param data - Optional safe metadata.
     */
    constructor(code, message, data = { retryable: false }, options) {
        super(message, options);
        this.name = 'BridgeError';
        this.rpcCode = JSON_RPC_CODES[code];
        this.data = { code, ...data };
    }
}
/** Convert an unknown failure to a redacted public bridge error. */
export function publicError(error) {
    if (error instanceof BridgeError)
        return error;
    if (error instanceof Error && (error.name === 'AbortError' || error.message === 'request cancelled by Connector')) {
        return new BridgeError('REQUEST_TIMEOUT', 'The bridge request was cancelled.', { retryable: true });
    }
    if (error instanceof Error && [
        'SessionFormatUnsupportedError',
        'SessionPersistenceCorruptionError',
    ].includes(error.name)) {
        return new BridgeError('PERSISTENCE_ERROR', 'The DSH Session could not be read safely.', { retryable: false });
    }
    return new BridgeError('INTERNAL_ERROR', 'The bridge could not complete the request.', { retryable: false });
}
//# sourceMappingURL=errors.js.map