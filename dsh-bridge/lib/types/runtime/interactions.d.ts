import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions';
import type { InteractionNotice } from '../wire/protocol.js';
import type { SessionController } from './session-controller.js';
import { type BridgeClientResponse, type BridgeMuxEnvelope, type BridgeRpcReceipt } from '../control/api-frames.js';
type NoticeEmitter = (notice: InteractionNotice) => void | Promise<void>;
type ControllerResolver = (agent: Agent) => SessionController | undefined;
type ReplicaEmitter = (sessionId: SessionController['externalSessionId'], envelope: BridgeMuxEnvelope) => void | Promise<void>;
type UserQuestionObserver = (request: AskUserQuestionRequest, next: (request?: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>;
declare module '@deepseek-ai/dsh-user-questions' {
    interface UserQuestionService {
        registerObserver(observer: UserQuestionObserver): () => void;
    }
}
/** Prepared response for an interaction owned by another process. */
export interface RemoteInteractionResponse {
    message: BridgeClientResponse;
    close(): Promise<void>;
}
/** Owns approval and user-question notices and their first-valid responses. */
export declare class InteractionManager {
    private readonly ctx;
    private readonly maxPending;
    private readonly controllerForAgent;
    private readonly emit;
    private readonly replicate;
    private readonly pending;
    private readonly remote;
    private readonly closed;
    private readonly shutdownSignal;
    /**
     * @param ctx - Bridge context providing approval and userQuestions.
     * @param maxPending - Whole-process pending interaction bound.
     * @param controllerForAgent - Exact root Agent ownership lookup.
     * @param emit - Connector notice publisher.
     * @param replicate - Web mux publisher used when this process owns the Agent.
     */
    constructor(ctx: Context, maxPending: number, controllerForAgent: ControllerResolver, emit: NoticeEmitter, replicate: ReplicaEmitter);
    /** Register approval handling and question mirroring when the host exposes that extension. */
    register(): () => void;
    /** Report whether this DSH build can mirror user questions to more than one client. */
    supportsUserQuestions(): boolean;
    /** Mirror a Web-owned question while preserving the Web UI provider as a competing answerer. */
    private observeQuestion;
    private findQuestionPendingId;
    /** Resolve one open interaction; invalid answers leave it open. */
    respond(platformSessionId: string, noticeId: string, actionId: string, inputData: unknown): Promise<{
        ok: true;
        duplicate: false;
    }>;
    /** Resolve one Web response forwarded from a follower process. */
    respondWeb(message: BridgeClientResponse): Promise<BridgeRpcReceipt>;
    /** Cancel every pending interaction during EOF, shutdown, or service disposal. */
    cancelAll(): Promise<void>;
    /** Cancel interactions owned by one Session before interrupt convergence. */
    cancelFor(controller: SessionController): Promise<void>;
    /** Current open notices for one AA Session. */
    notices(platformSessionId: string): InteractionNotice[];
    /** Upsert or resolve one Web interaction replicated from a remote owner. */
    consumeWebEnvelope(platformSessionId: string, envelope: BridgeMuxEnvelope): Promise<void>;
    /** Validate an AA answer and prepare the corresponding Web response envelope. */
    prepareRemoteResponse(platformSessionId: string, externalSessionId: string, noticeIdValue: string, actionId: string, inputData: unknown): RemoteInteractionResponse | undefined;
    /** Current Web interaction envelopes for one follower baseline. */
    webBaselines(externalSessionId: SessionController['externalSessionId']): BridgeMuxEnvelope[];
    private askApproval;
    private askQuestion;
    private cancel;
    private close;
    private approvalIdFor;
    private replicateRequested;
    private requestedEnvelope;
    private replicateResolved;
    private publishReplica;
}
export {};
