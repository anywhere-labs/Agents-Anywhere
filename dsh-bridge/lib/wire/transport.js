import { once } from 'node:events';
import { BridgeError, publicError } from './errors.js';
import { isRecord, validateInboundFrame } from './validation.js';
/** Bounded NDJSON JSON-RPC transport over a child process's stdio. */
export class StdioJsonRpcTransport {
    input;
    output;
    maxFrameBytes;
    handler;
    buffered = Buffer.alloc(0);
    started = false;
    stopped = false;
    writeTail = Promise.resolve();
    /**
     * Create the transport without claiming stdin yet.
     * @param input - Protocol input stream.
     * @param output - Protocol-only output stream.
     * @param maxFrameBytes - Maximum bytes before LF.
     * @param handler - Dispatcher and lifecycle callbacks.
     */
    constructor(input, output, maxFrameBytes, handler) {
        this.input = input;
        this.output = output;
        this.maxFrameBytes = maxFrameBytes;
        this.handler = handler;
    }
    /** Start the single stdin reader owned by this transport. */
    start() {
        if (this.started)
            throw new Error('stdio transport already started');
        this.started = true;
        this.input.on('data', this.onData);
        this.input.once('end', this.onEnd);
        this.input.once('error', this.onInputError);
    }
    /** Stop accepting input while preserving output for the final response. */
    stopInput() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.input.off('data', this.onData);
        this.input.off('end', this.onEnd);
        this.input.off('error', this.onInputError);
        this.input.pause();
    }
    /** Send a protocol notification with serialized stdout backpressure. */
    notify(method, params) {
        return this.enqueue({ jsonrpc: '2.0', method, params });
    }
    /** Wait until all accepted protocol frames have reached stdout. */
    async flush() {
        await this.writeTail;
    }
    onData = (chunk) => {
        if (this.stopped)
            return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        this.buffered = Buffer.concat([this.buffered, bytes]);
        this.consumeLines();
    };
    onEnd = () => {
        if (this.stopped)
            return;
        if (this.buffered.length > 0) {
            this.buffered = Buffer.alloc(0);
            void this.failFatal(new BridgeError('INVALID_REQUEST', 'The final protocol frame was not terminated by LF.', { retryable: false }));
            return;
        }
        this.buffered = Buffer.alloc(0);
        void this.handler.eof();
    };
    onInputError = () => {
        void this.failFatal(new BridgeError('INTERNAL_ERROR', 'The bridge input stream failed.', { retryable: false }));
    };
    consumeLines() {
        let newline = this.buffered.indexOf(0x0a);
        while (newline !== -1) {
            let line = this.buffered.subarray(0, newline);
            this.buffered = this.buffered.subarray(newline + 1);
            if (line.at(-1) === 0x0d)
                line = line.subarray(0, -1);
            if (line.length > this.maxFrameBytes) {
                void this.failFatal(new BridgeError('FRAME_TOO_LARGE', 'Inbound frame exceeded the configured byte limit.', { retryable: false }));
                return;
            }
            this.acceptLine(line);
            if (this.stopped)
                return;
            newline = this.buffered.indexOf(0x0a);
        }
        if (this.buffered.length > this.maxFrameBytes) {
            void this.failFatal(new BridgeError('FRAME_TOO_LARGE', 'Inbound frame exceeded the configured byte limit.', { retryable: false }));
        }
    }
    acceptLine(bytes) {
        if (bytes.length === 0) {
            this.rejectFrame(null, new BridgeError('INVALID_REQUEST', 'Empty protocol frames are not allowed.', { retryable: false }));
            return;
        }
        if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
            this.rejectFrame(null, new BridgeError('INVALID_REQUEST', 'A UTF-8 BOM is not allowed.', { retryable: false }));
            return;
        }
        let line;
        try {
            line = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        catch {
            this.rejectFrame(null, new BridgeError('PARSE_ERROR', 'Frame is not valid UTF-8.', { retryable: false }));
            return;
        }
        let decoded;
        try {
            decoded = JSON.parse(line);
        }
        catch {
            this.rejectFrame(null, new BridgeError('PARSE_ERROR', 'Invalid JSON.', { retryable: false }));
            return;
        }
        let frame;
        try {
            frame = validateInboundFrame(decoded);
        }
        catch (error) {
            this.rejectFrame(errorId(decoded), publicError(error));
            return;
        }
        if ('id' in frame) {
            void this.dispatchRequest(frame).catch(() => this.failFatal(new BridgeError('INTERNAL_ERROR', 'The bridge output stream failed.', { retryable: false })));
        }
        else {
            void this.handler.notification(frame).catch(error => this.reportNotificationFailure(frame.method, error));
        }
    }
    async dispatchRequest(frame) {
        try {
            const result = await this.handler.request(frame);
            const response = { jsonrpc: '2.0', id: frame.id, result };
            await this.enqueue(response);
        }
        catch (error) {
            const exposed = publicError(error);
            if (exposed.data.code === 'FRAME_TOO_LARGE') {
                await this.failFatal(exposed);
                return;
            }
            await this.sendFailure(frame.id, exposed);
        }
    }
    reportNotificationFailure(method, error) {
        const message = error instanceof BridgeError ? error.data.code : 'INTERNAL_ERROR';
        process.stderr.write(`[aa-dsh-bridge] notification ${method} failed: ${message}\n`);
    }
    sendFailure(id, error) {
        const response = {
            jsonrpc: '2.0',
            id,
            error: { code: error.rpcCode, message: error.message, data: { ...error.data } },
        };
        return this.enqueue(response);
    }
    rejectFrame(id, error) {
        void this.sendFailure(id, error).catch(() => this.failFatal(new BridgeError('INTERNAL_ERROR', 'The bridge output stream failed.', { retryable: false })));
    }
    enqueue(frame) {
        const line = `${JSON.stringify(frame)}\n`;
        if (Buffer.byteLength(line) > this.maxFrameBytes + 1) {
            return Promise.reject(new BridgeError('FRAME_TOO_LARGE', 'Outbound frame exceeded the configured byte limit.', { retryable: false }));
        }
        this.writeTail = this.writeTail.then(async () => {
            if (!this.output.write(line))
                await once(this.output, 'drain');
        });
        return this.writeTail;
    }
    async failFatal(error) {
        this.stopInput();
        await this.handler.fatal(error);
    }
}
function errorId(value) {
    if (!isRecord(value))
        return null;
    const id = value.id;
    if ((typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isSafeInteger(id)))
        return id;
    return null;
}
//# sourceMappingURL=transport.js.map