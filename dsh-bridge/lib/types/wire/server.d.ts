import { type TransportHandler } from './transport.js';
/** Connector discovery record written below the configured bridge state root. */
export interface BridgeEndpoint {
    readonly version: 1;
    readonly host: '127.0.0.1';
    readonly port: number;
    readonly token: string;
    readonly pid: number;
}
/** Handler for one authenticated Connector connection. */
export interface LoopbackServerHandler extends TransportHandler {
    /** Reset connection-scoped bridge state without stopping the DSH host. */
    disconnected(reason: string): Promise<void>;
}
/** Authenticated single-Connector JSON-RPC endpoint bound to the loopback interface. */
export declare class LoopbackJsonRpcServer {
    private readonly stateRoot;
    private readonly maxFrameBytes;
    private readonly handler;
    readonly endpointPath: string;
    private readonly token;
    private server;
    private active;
    /**
     * @param stateRoot - Absolute private directory shared with Connector discovery.
     * @param maxFrameBytes - Maximum bytes accepted before one LF delimiter.
     * @param handler - Bridge request dispatcher and connection lifecycle owner.
     */
    constructor(stateRoot: string, maxFrameBytes: number, handler: LoopbackServerHandler);
    /** Bind an ephemeral loopback port and atomically publish its authenticated descriptor. */
    start(): Promise<BridgeEndpoint>;
    /** Send one notification to the initialized Connector connection. */
    notify(method: string, params: Record<string, unknown>): Promise<void>;
    /** Stop accepting connections, close the active client, and remove this exact descriptor. */
    stop(): Promise<void>;
    private accept;
    private request;
    private notification;
    private fatal;
    private disconnect;
}
