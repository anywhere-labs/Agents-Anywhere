/** Stable bridge error identifiers carried in JSON-RPC error data. */
export type BridgeErrorCode = 'PARSE_ERROR' | 'INVALID_REQUEST' | 'METHOD_NOT_FOUND' | 'INVALID_PARAMS' | 'INTERNAL_ERROR' | 'UNSUPPORTED_OPERATION' | 'SESSION_NOT_FOUND' | 'SESSION_CONFLICT' | 'SESSION_BINDING_CONFLICT' | 'INVALID_SELECTION' | 'INTERACTION_ALREADY_CLOSED' | 'REQUEST_TIMEOUT' | 'DSH_SERVICE_UNAVAILABLE' | 'PERSISTENCE_ERROR' | 'PROTOCOL_VERSION_MISMATCH' | 'SHUTTING_DOWN' | 'IDEMPOTENCY_CONFLICT' | 'NOT_INITIALIZED' | 'FRAME_TOO_LARGE' | 'DSH_CONCURRENT_WRITER_DETECTED' | 'COMMAND_NOT_FOUND';
/** Safe optional error metadata exposed across the process boundary. */
export interface BridgeErrorData {
    code: BridgeErrorCode;
    retryable: boolean;
    sessionId?: string;
    externalSessionId?: string;
    details?: string;
}
/** Error whose public fields are safe to serialize to the Connector. */
export declare class BridgeError extends Error {
    readonly rpcCode: number;
    readonly data: BridgeErrorData;
    /**
     * Create a public bridge failure.
     * @param code - Stable bridge error identifier.
     * @param message - Prompt-free public description.
     * @param data - Optional safe metadata.
     */
    constructor(code: BridgeErrorCode, message: string, data?: Omit<BridgeErrorData, 'code'>, options?: ErrorOptions);
}
/** Convert an unknown failure to a redacted public bridge error. */
export declare function publicError(error: unknown): BridgeError;
