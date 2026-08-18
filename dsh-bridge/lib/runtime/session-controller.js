import { RUNTIME_ID } from '../wire/protocol.js';
import { modelSelectionId } from '../projection/identity.js';
import { BridgeError } from '../wire/errors.js';
/** Process-local owner of one DSH Session's serialization and live Agent handle. */
export class SessionController {
    externalSessionId;
    platformSessionId;
    permissionSelectionId;
    onState;
    selection;
    pendingInteractionIds = new Set();
    handle;
    borrowedAgent;
    lastObservedRevision;
    localAppendsSinceRevision = 0;
    error;
    serialTail = Promise.resolve();
    stateRevision = 0;
    currentStatus = 'idle';
    /**
     * @param externalSessionId - Branded DSH Session identity.
     * @param platformSessionId - Bound AA Session identity when known.
     * @param initialSelection - Model route restored or selected for this Session.
     * @param permissionSelectionId - Effective permission selection ID.
     * @param onState - Notification callback after every semantic state change.
     */
    constructor(externalSessionId, platformSessionId, initialSelection, permissionSelectionId, onState) {
        this.externalSessionId = externalSessionId;
        this.platformSessionId = platformSessionId;
        this.permissionSelectionId = permissionSelectionId;
        this.onState = onState;
        this.selection = { current: initialSelection, assembled: undefined };
    }
    /** Current AA runtime status. */
    get status() {
        return this.currentStatus;
    }
    /** Run one Session operation after all earlier operations settle. */
    enqueue(operation) {
        const run = this.serialTail.then(operation, operation);
        this.serialTail = run.then(() => undefined, () => undefined);
        return run;
    }
    /** Wait until every accepted serialized operation has settled. */
    async drain() {
        await this.serialTail;
    }
    /** Attach the exact Agent handle whose ownership lease is held by AgentRegistry. */
    attach(handle) {
        if (this.handle !== undefined || this.borrowedAgent !== undefined) {
            throw new Error(`Session ${this.externalSessionId} already has a live Agent`);
        }
        this.handle = handle;
    }
    /** Observe an Agent owned by another Consumer in this same process. */
    attachBorrowed(agent) {
        if (this.handle?.agent === agent || this.borrowedAgent === agent)
            return;
        if (this.handle !== undefined || this.borrowedAgent !== undefined) {
            throw new Error(`Session ${this.externalSessionId} already has a different live Agent`);
        }
        this.borrowedAgent = agent;
    }
    /** Exact live Agent currently controlled in this process. */
    get agent() {
        return this.handle?.agent ?? this.borrowedAgent;
    }
    /** Return the exact retained live Agent or fail safely when it became stale. */
    requireLive(getAgent) {
        const agent = this.agent;
        if (agent === undefined || getAgent(agent.id) !== agent) {
            throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'The retained DSH Agent is no longer live.', {
                retryable: true,
                externalSessionId: String(this.externalSessionId),
            });
        }
        return agent;
    }
    /** Update model routing for the next step. */
    async updateModel(selection) {
        this.selection.current = selection;
        await this.publishState();
    }
    /** Update the permission selection after the canonical DSH setter succeeds. */
    async updatePermission(selectionId) {
        this.permissionSelectionId = selectionId;
        await this.publishState();
    }
    /** Enter a new state and publish only when it changed. */
    async transition(status, error) {
        const changed = this.currentStatus !== status
            || this.error?.code !== error?.code
            || this.error?.message !== error?.message;
        if (!changed)
            return;
        this.currentStatus = status;
        this.error = error;
        await this.publishState();
    }
    /** Add one pending interaction and expose its blocking status. */
    async openInteraction(id, kind) {
        this.pendingInteractionIds.add(id);
        await this.transition(kind === 'approval' ? 'waiting_approval' : 'blocked');
    }
    /** Close a pending interaction and return to the Agent's effective state. */
    async closeInteraction(id) {
        this.pendingInteractionIds.delete(id);
        if (this.pendingInteractionIds.size > 0)
            return;
        await this.transition(this.agent?.status === 'running' ? 'running' : 'idle');
    }
    /** Materialize the public state DTO when the AA binding is known. */
    state() {
        if (this.platformSessionId === undefined)
            return undefined;
        return {
            sessionId: this.platformSessionId,
            externalSessionId: String(this.externalSessionId),
            runtime: RUNTIME_ID,
            status: this.currentStatus,
            selections: {
                model: modelSelectionId(this.selection.current),
                permission: this.permissionSelectionId,
            },
            revision: this.stateRevision,
            ...(this.error === undefined ? {} : { error: this.error }),
        };
    }
    /** Dispose the owned handle; AgentRegistry releases its exact ownership lease. */
    async dispose() {
        const handle = this.handle;
        this.handle = undefined;
        this.borrowedAgent = undefined;
        await handle?.dispose();
    }
    /** Forget a handle after an external lifecycle owner removed the Agent. */
    async detachStale() {
        this.handle = undefined;
        this.borrowedAgent = undefined;
    }
    async publishState() {
        this.stateRevision += 1;
        await this.onState(this);
    }
}
//# sourceMappingURL=session-controller.js.map