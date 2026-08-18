import { randomBytes } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { BridgeError } from './errors.js';
import { StdioJsonRpcTransport } from './transport.js';
import { readOptionalJson, removeFile, writeJsonAtomic } from '../persistence/files.js';
const ENDPOINT_VERSION = 1;
/** Authenticated single-Connector JSON-RPC endpoint bound to the loopback interface. */
export class LoopbackJsonRpcServer {
    stateRoot;
    maxFrameBytes;
    handler;
    endpointPath;
    token = randomBytes(32).toString('base64url');
    server;
    active;
    /**
     * @param stateRoot - Absolute private directory shared with Connector discovery.
     * @param maxFrameBytes - Maximum bytes accepted before one LF delimiter.
     * @param handler - Bridge request dispatcher and connection lifecycle owner.
     */
    constructor(stateRoot, maxFrameBytes, handler) {
        this.stateRoot = stateRoot;
        this.maxFrameBytes = maxFrameBytes;
        this.handler = handler;
        this.endpointPath = join(stateRoot, 'endpoint.json');
    }
    /** Bind an ephemeral loopback port and atomically publish its authenticated descriptor. */
    async start() {
        if (this.server !== undefined)
            throw new Error('agents-anywhere bridge endpoint is already started');
        await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
        await chmod(this.stateRoot, 0o700);
        const server = createServer(socket => this.accept(socket));
        this.server = server;
        await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            server.once('error', onError);
            server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
                server.off('error', onError);
                resolve();
            });
        });
        const address = server.address();
        if (address === null || typeof address === 'string')
            throw new Error('agents-anywhere bridge endpoint has no TCP address');
        const endpoint = {
            version: ENDPOINT_VERSION,
            host: '127.0.0.1',
            port: address.port,
            token: this.token,
            pid: process.pid,
        };
        await writeJsonAtomic(this.endpointPath, endpoint);
        return endpoint;
    }
    /** Send one notification to the initialized Connector connection. */
    notify(method, params) {
        const active = this.active;
        if (active === undefined || !active.authenticated) {
            return Promise.reject(new Error('agents-anywhere Connector is not connected'));
        }
        return active.transport.notify(method, params);
    }
    /** Stop accepting connections, close the active client, and remove this exact descriptor. */
    async stop() {
        const active = this.active;
        this.active = undefined;
        if (active !== undefined) {
            active.transport.stopInput();
            active.socket.destroy();
        }
        const server = this.server;
        this.server = undefined;
        if (server !== undefined) {
            await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
        }
        const endpoint = await readOptionalJson(this.endpointPath);
        if (isBridgeEndpoint(endpoint) && endpoint.token === this.token && endpoint.pid === process.pid) {
            await removeFile(this.endpointPath);
        }
    }
    accept(socket) {
        if (this.active !== undefined) {
            socket.destroy();
            return;
        }
        socket.setNoDelay(true);
        let connection;
        const transport = new StdioJsonRpcTransport(socket, socket, this.maxFrameBytes, {
            request: frame => this.request(connection, frame),
            notification: frame => this.notification(connection, frame),
            eof: () => this.disconnect(connection, 'connector-disconnected'),
            fatal: error => this.fatal(connection, error),
        });
        connection = { socket, transport, authenticated: false };
        this.active = connection;
        transport.start();
    }
    async request(connection, frame) {
        if (!connection.authenticated) {
            if (frame.method !== 'initialize' || frame.params.authToken !== this.token) {
                throw new BridgeError('INVALID_REQUEST', 'Connector authentication failed.', { retryable: false });
            }
            const result = await this.handler.request(frame);
            connection.authenticated = true;
            return result;
        }
        return this.handler.request(frame);
    }
    notification(connection, frame) {
        if (!connection.authenticated) {
            return Promise.reject(new BridgeError('NOT_INITIALIZED', 'initialize must be the first request.', { retryable: false }));
        }
        return this.handler.notification(frame);
    }
    async fatal(connection, error) {
        await this.disconnect(connection, error.data.code);
        await this.handler.fatal(error);
    }
    async disconnect(connection, reason) {
        if (this.active !== connection)
            return;
        this.active = undefined;
        connection.transport.stopInput();
        connection.socket.destroy();
        await this.handler.disconnected(reason);
    }
}
function isBridgeEndpoint(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const endpoint = value;
    return endpoint.version === ENDPOINT_VERSION
        && endpoint.host === '127.0.0.1'
        && Number.isSafeInteger(endpoint.port)
        && typeof endpoint.token === 'string'
        && endpoint.token.length > 0
        && Number.isSafeInteger(endpoint.pid);
}
//# sourceMappingURL=server.js.map