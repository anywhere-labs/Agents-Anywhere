import type { Context } from '@deepseek-ai/cordis';
import { type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent';
import { type ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { MetadataStore } from '../persistence/metadata.js';
import { type SessionMeta } from '../wire/protocol.js';
import type { CatalogManager } from './catalogs.js';
import type { InteractionManager } from './interactions.js';
import { SessionController } from './session-controller.js';
import { type BridgeHostEnvelope, type BridgeLiveBaseline, type BridgeMuxEnvelope } from '../control/api-frames.js';
type NotificationEmitter = (method: string, params: Record<string, unknown>) => void | Promise<void>;
type ReplicaEmitter = (sessionId: SessionId, envelope: BridgeMuxEnvelope) => void | Promise<void>;
type HostReplicaEmitter = (sessionId: SessionId, envelope: BridgeHostEnvelope) => void | Promise<void>;
/** Model and permission IDs accepted by a write request. */
export interface RequestedSelections {
    model?: string;
    permission?: string;
}
/** Text message operation shared by create/start/steer. */
export interface MessageOperation {
    sessionId: string;
    externalSessionId?: string;
    content: string;
    clientMessageId: string;
    selections?: RequestedSelections;
}
/** Prompt part forwarded from a DSH Desktop follower. */
export type ApiPromptPart = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    mediaType: ImageMediaType;
    data: string;
    name?: string;
};
/** Owns Session discovery, live Agent handles, serialization, and notifications. */
export declare class SessionManager {
    private readonly ctx;
    private readonly metadata;
    private readonly catalogs;
    readonly maxListLimit: number;
    readonly maxCommandLimit: number;
    private readonly emit;
    private readonly replicate;
    private readonly replicateHost;
    private readonly controllers;
    private readonly replicaHistories;
    private readonly cursorKey;
    private interactions;
    /**
     * @param ctx - Bridge context with all required DSH services.
     * @param metadata - Bridge-only durable metadata.
     * @param catalogs - Current model and permission catalog.
     * @param maxListLimit - Wire Session list bound.
     * @param maxCommandLimit - Wire command list bound.
     * @param emit - Protocol notification publisher.
     * @param replicate - Web mux publisher used when this process owns the Agent.
     * @param replicateHost - Web Host-status publisher used by the Agent owner.
     */
    constructor(ctx: Context, metadata: MetadataStore, catalogs: CatalogManager, maxListLimit: number, maxCommandLimit: number, emit: NotificationEmitter, replicate: ReplicaEmitter, replicateHost: HostReplicaEmitter);
    /** Attach the interaction owner after both managers have been constructed. */
    setInteractions(interactions: InteractionManager): void;
    /** Register live DSH event observers owned by the bridge fiber. */
    registerObservers(): () => void;
    private publishHostReplica;
    private publishReplicaEvent;
    private publishReplica;
    /** Exact controller ownership check used by approval and question routing. */
    controllerForAgent(agent: Agent): SessionController | undefined;
    /** Discover materialized DSH Sessions with stable signed pagination. */
    listSessions(limit: number, cursor: string | undefined, _force: boolean, signal?: AbortSignal): Promise<{
        sessions: SessionMeta[];
        nextCursor: string | null;
    }>;
    /** Return a suffix projection without taking a live Agent handle. */
    snapshot(platformSessionId: string, externalSessionId: string, fromSeq: number, eventLimit: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
    /** Return live or cold Session state without resuming a cold Agent. */
    state(platformSessionId: string, externalSessionId: string, signal?: AbortSignal): Promise<Record<string, unknown> | null>;
    /** Return open interaction notices for one Session. */
    notices(platformSessionId: string, externalSessionId: string): Promise<Record<string, unknown>>;
    /** Return capabilities using live or cold state and current model validity. */
    capabilities(platformSessionId: string, externalSessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
    /** Create a native DSH Session, deliver its first message, and await durability. */
    createAndStart(operation: MessageOperation & {
        cwd: string;
        attachments: unknown[];
    }, signal?: AbortSignal): Promise<Record<string, unknown>>;
    /** Start one ordinary follow-up turn on an idle Session. */
    startTurn(operation: MessageOperation & {
        externalSessionId: string;
    }, signal?: AbortSignal): Promise<Record<string, unknown>>;
    /** Queue steering for the next step of a running Agent. */
    steer(operation: MessageOperation & {
        externalSessionId: string;
    }, signal?: AbortSignal): Promise<Record<string, unknown>>;
    /** Interrupt running work and converge to idle. */
    interrupt(platformSessionId: string, externalSessionId: string): Promise<Record<string, unknown>>;
    /** Update idle model and permission selection for the next step. */
    updateSelections(platformSessionId: string, externalSessionId: string, selections: RequestedSelections, signal?: AbortSignal): Promise<Record<string, unknown>>;
    /** Resume if needed and list effective Session commands. */
    listCommands(platformSessionId: string, externalSessionId: string, query: string | undefined, limit: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
    /** Execute one canonical DSH command while idle. */
    executeCommand(platformSessionId: string, externalSessionId: string, command: string, raw: string | undefined, args: string, signal: AbortSignal): Promise<Record<string, unknown>>;
    /** Validate and settle one interaction through the owning Session queue. */
    respondInteraction(platformSessionId: string, externalSessionId: string, noticeId: string, actionId: string, inputData: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
    /** Flush, cancel, and dispose every owned Agent handle. */
    shutdown(): Promise<{
        disposedSessions: number;
        failedSessions: number;
    }>;
    /** Reject handoff while the Agent, inbox, serialized queue, or interactions are active. */
    assertHandoffReady(sessionId: SessionId): Promise<void>;
    /** Resume a Session assigned to this process by an explicit handoff. */
    activate(sessionId: SessionId): Promise<void>;
    /** Return the Web queue, interactions, and status for a follower baseline. */
    webBaseline(sessionId: SessionId): BridgeLiveBaseline;
    /** Project one remote owner's Web mux envelope into AA notifications. */
    consumeWebMux(envelope: BridgeMuxEnvelope): Promise<void>;
    /** Project one remote owner's Host status envelope into AA state. */
    consumeWebHost(envelope: BridgeHostEnvelope): Promise<void>;
    /** Accept one Web prompt in the process that currently owns its Agent. */
    apiPrompt(input: {
        sessionId: SessionId;
        rpcId: string;
        clientMessageId: string;
        mode: 'queue' | 'steer';
        content: readonly ApiPromptPart[];
        clientTimeZone?: string;
    }): Promise<{
        accepted: true;
    }>;
    /** Mutate one pending Web queue item on the owner process. */
    apiUpdateQueue(sessionId: SessionId, itemId: string, action: {
        kind: 'edit' | 'remove' | 'steer';
        content?: ContentBlock[];
    }): Promise<{
        accepted: true;
    }>;
    /** Cancel the owner process's active Web turn while preserving queued work. */
    apiCancel(sessionId: SessionId): Promise<{
        accepted: true;
    }>;
    /** Return the owner process's model selection and current catalog. */
    apiModels(sessionId: SessionId): Promise<Record<string, unknown>>;
    /** Change the owner process's model selection for the next request. */
    apiSelectModel(sessionId: SessionId, selection: ModelSelection): Promise<{
        selected: ModelSelection;
    }>;
    /** Append a user-pinned title through the canonical Session title service. */
    apiRename(sessionId: SessionId, title: string): Promise<{
        title: string;
        seq: number;
    }>;
    /** Return command descriptors from the owner process's effective registry. */
    apiCommands(sessionId: SessionId): Promise<{
        commands: ReturnType<Context['commands']['list']>;
    }>;
    /** Execute one complete slash-command line on the owner process. */
    apiCommand(sessionId: SessionId, line: string, signal: AbortSignal): Promise<{
        execution: Awaited<ReturnType<Context['commands']['execute']>> | null;
    }>;
    private coldController;
    private verifyCommittedCreate;
    private interactionsOrThrow;
    private writableController;
    private apiController;
    private resume;
    private submitMessage;
    private applySelections;
    private requestedModel;
    private requestedPermission;
    private selectionFromEvents;
    private ensureBinding;
    private metaFor;
    private archivedSessionIds;
    private publishEvent;
    private onControllerState;
    private modelAvailable;
    private checkRevision;
    private observeRevision;
    private detectConcurrentWriters;
    private quarantineConcurrentWriter;
    private revisionOf;
    private encodeCursor;
    private decodeCursor;
}
export {};
