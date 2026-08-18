import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence';
import type { RuntimeStatus, SessionState } from '../wire/protocol.js';
/** State change callback owned by the Session registry. */
export type ControllerStateListener = (controller: SessionController) => void | Promise<void>;
/** Process-local owner of one DSH Session's serialization and live Agent handle. */
export declare class SessionController {
    readonly externalSessionId: SessionId;
    platformSessionId: string | undefined;
    permissionSelectionId: string;
    private readonly onState;
    readonly selection: ModelSelectionRef;
    readonly pendingInteractionIds: Set<string>;
    handle: AgentHandle | undefined;
    private borrowedAgent;
    lastObservedRevision: SessionPersistenceRevision | undefined;
    localAppendsSinceRevision: number;
    error: {
        code: string;
        message: string;
    } | undefined;
    private serialTail;
    private stateRevision;
    private currentStatus;
    /**
     * @param externalSessionId - Branded DSH Session identity.
     * @param platformSessionId - Bound AA Session identity when known.
     * @param initialSelection - Model route restored or selected for this Session.
     * @param permissionSelectionId - Effective permission selection ID.
     * @param onState - Notification callback after every semantic state change.
     */
    constructor(externalSessionId: SessionId, platformSessionId: string | undefined, initialSelection: ModelSelection, permissionSelectionId: string, onState: ControllerStateListener);
    /** Current AA runtime status. */
    get status(): RuntimeStatus;
    /** Run one Session operation after all earlier operations settle. */
    enqueue<T>(operation: () => Promise<T>): Promise<T>;
    /** Wait until every accepted serialized operation has settled. */
    drain(): Promise<void>;
    /** Attach the exact Agent handle whose ownership lease is held by AgentRegistry. */
    attach(handle: AgentHandle): void;
    /** Observe an Agent owned by another Consumer in this same process. */
    attachBorrowed(agent: Agent): void;
    /** Exact live Agent currently controlled in this process. */
    get agent(): Agent | undefined;
    /** Return the exact retained live Agent or fail safely when it became stale. */
    requireLive(getAgent: (id: SessionId) => AgentHandle['agent'] | undefined): AgentHandle['agent'];
    /** Update model routing for the next step. */
    updateModel(selection: ModelSelection): Promise<void>;
    /** Update the permission selection after the canonical DSH setter succeeds. */
    updatePermission(selectionId: string): Promise<void>;
    /** Enter a new state and publish only when it changed. */
    transition(status: RuntimeStatus, error?: {
        code: string;
        message: string;
    }): Promise<void>;
    /** Add one pending interaction and expose its blocking status. */
    openInteraction(id: string, kind: 'approval' | 'user_question'): Promise<void>;
    /** Close a pending interaction and return to the Agent's effective state. */
    closeInteraction(id: string): Promise<void>;
    /** Materialize the public state DTO when the AA binding is known. */
    state(): SessionState | undefined;
    /** Dispose the owned handle; AgentRegistry releases its exact ownership lease. */
    dispose(): Promise<void>;
    /** Forget a handle after an external lifecycle owner removed the Agent. */
    detachStale(): Promise<void>;
    private publishState;
}
