import type { Readable, Writable } from 'node:stream';
import { BridgeError } from './errors.js';
import type { InboundFrame, JsonRpcRequest } from './types.js';
/** Callbacks owned by the bridge dispatcher. */
export interface TransportHandler {
    request(frame: JsonRpcRequest): Promise<unknown>;
    notification(frame: Exclude<InboundFrame, JsonRpcRequest>): Promise<void>;
    eof(): Promise<void>;
    fatal(error: BridgeError): Promise<void>;
}
/** Bounded NDJSON JSON-RPC transport over a child process's stdio. */
export declare class StdioJsonRpcTransport {
    private readonly input;
    private readonly output;
    private readonly maxFrameBytes;
    private readonly handler;
    private buffered;
    private started;
    private stopped;
    private writeTail;
    /**
     * Create the transport without claiming stdin yet.
     * @param input - Protocol input stream.
     * @param output - Protocol-only output stream.
     * @param maxFrameBytes - Maximum bytes before LF.
     * @param handler - Dispatcher and lifecycle callbacks.
     */
    constructor(input: Readable, output: Writable, maxFrameBytes: number, handler: TransportHandler);
    /** Start the single stdin reader owned by this transport. */
    start(): void;
    /** Stop accepting input while preserving output for the final response. */
    stopInput(): void;
    /** Send a protocol notification with serialized stdout backpressure. */
    notify(method: string, params: Record<string, unknown>): Promise<void>;
    /** Wait until all accepted protocol frames have reached stdout. */
    flush(): Promise<void>;
    private readonly onData;
    private readonly onEnd;
    private readonly onInputError;
    private consumeLines;
    private acceptLine;
    private dispatchRequest;
    private reportNotificationFailure;
    private sendFailure;
    private rejectFrame;
    private enqueue;
    private failFatal;
}
