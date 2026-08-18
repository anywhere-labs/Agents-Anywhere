import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { BridgeError } from './wire/errors.js';
import { type LoopbackServerHandler } from './wire/server.js';
import type { JsonRpcNotification, JsonRpcRequest } from './wire/types.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        agentsAnywhereBridge: AgentsAnywhereBridgeService;
    }
}
/** Deployment-tunable bridge settings. */
export interface Config {
    stateRoot?: string;
    maxFrameBytes?: number;
    readRequestTimeoutMs?: number;
    writeRequestTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    maxListLimit?: number;
    maxCommandLimit?: number;
    maxPendingInteractions?: number;
}
/** Agents Anywhere SDK service hosted by the DSH Web process. */
export declare class AgentsAnywhereBridgeService extends Service implements LoopbackServerHandler {
    static Config: z<Config>;
    static inject: string[];
    private readonly config;
    private readonly metadata;
    private readonly activeRequests;
    private endpoint;
    private catalogs;
    private sessions;
    private interactions;
    private initialized;
    private connectorId;
    private shuttingDown;
    private shutdownPromise;
    private disposeRegistrations;
    /**
     * Construct the service without claiming process streams.
     * @param ctx - Fully composed DSH base context.
     * @param config - Schema-validated plugin configuration.
     */
    constructor(ctx: Context, config: Config);
    /** Validate composition, register reversible resources, and start the loopback endpoint. */
    [Service.init](): Promise<void>;
    /** Dispatch one concurrent JSON-RPC request with duplicate-ID protection. */
    request(frame: JsonRpcRequest): Promise<unknown>;
    /** Handle supported Connector notifications. */
    notification(frame: JsonRpcNotification): Promise<void>;
    /** Reset connection state after a Connector disconnect without stopping DSH Web. */
    eof(): Promise<void>;
    /** Log an unrecoverable connection failure without stopping DSH Web. */
    fatal(error: BridgeError): Promise<void>;
    /** Abort connection-scoped work and permit the next authenticated Connector. */
    disconnected(reason: string): Promise<void>;
    private dispatch;
    private initialize;
    private publishCatalogs;
    private notify;
    private shutdownCore;
    private validateStateRoot;
    private requireCatalogs;
    private requireSessions;
}
export default AgentsAnywhereBridgeService;
