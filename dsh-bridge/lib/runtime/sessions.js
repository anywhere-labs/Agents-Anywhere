import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { installModelSelection, } from '@deepseek-ai/dsh-agent';
import { AttachmentError } from '@deepseek-ai/dsh-attachment';
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import { contentHash, deterministicMessageId, modelSelectionId, permissionSelectionId, sha256Hex, timelineItemId, } from '../projection/identity.js';
import { projectTimeline } from '../projection/timeline.js';
import { timelineWatermark } from '../projection/watermark.js';
import { BridgeError } from '../wire/errors.js';
import { RUNTIME_ID } from '../wire/protocol.js';
import { sessionCapabilities } from './capabilities.js';
import { SessionController } from './session-controller.js';
import { sessionSyncRevision, sessionVisibility } from './session-visibility.js';
import { bridgeHostEnvelope, bridgeMuxEnvelope, } from '../control/api-frames.js';
/** Owns Session discovery, live Agent handles, serialization, and notifications. */
export class SessionManager {
    ctx;
    metadata;
    catalogs;
    maxListLimit;
    maxCommandLimit;
    emit;
    replicate;
    replicateHost;
    controllers = new Map();
    replicaHistories = new Map();
    cursorKey = randomBytes(32);
    interactions;
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
    constructor(ctx, metadata, catalogs, maxListLimit, maxCommandLimit, emit, replicate, replicateHost) {
        this.ctx = ctx;
        this.metadata = metadata;
        this.catalogs = catalogs;
        this.maxListLimit = maxListLimit;
        this.maxCommandLimit = maxCommandLimit;
        this.emit = emit;
        this.replicate = replicate;
        this.replicateHost = replicateHost;
    }
    /** Attach the interaction owner after both managers have been constructed. */
    setInteractions(interactions) {
        this.interactions = interactions;
    }
    /** Register live DSH event observers owned by the bridge fiber. */
    registerObservers() {
        const disposeStatus = this.ctx.on('agent/status', ({ agent, status }) => {
            const controller = this.controllerForAgent(agent);
            if (controller !== undefined) {
                void this.publishHostReplica(agent.id, bridgeHostEnvelope({
                    type: 'host/session-status',
                    sessionId: agent.id,
                    running: status === 'running',
                }));
            }
            if (controller === undefined || controller.pendingInteractionIds.size > 0 || controller.status === 'stopping')
                return;
            void controller.transition(status);
        });
        const disposeError = this.ctx.on('agent/error', ({ agent, error }) => {
            if (this.controllerForAgent(agent) === undefined)
                return;
            void this.publishHostReplica(agent.id, bridgeHostEnvelope({
                type: 'host/agent-error',
                sessionId: agent.id,
                message: error instanceof Error ? error.message : String(error),
            }));
        });
        const disposeAgent = this.ctx.on('agent/disposed', ({ agent }) => {
            const controller = this.controllers.get(agent.id);
            if (controller?.agent !== agent)
                return;
            if (controller !== undefined)
                void controller.detachStale();
        });
        const disposeEvent = this.ctx.on('session/event', (session, event) => {
            const controller = this.controllers.get(session.id);
            if (controller === undefined)
                return;
            controller.localAppendsSinceRevision += 1;
            return Promise.all([
                this.publishEvent(controller, session.header, session.events, event),
                this.publishReplicaEvent(controller.agent, session.id, event),
            ]).then(() => undefined);
        });
        return () => {
            disposeStatus();
            disposeError();
            disposeAgent();
            disposeEvent();
        };
    }
    async publishHostReplica(sessionId, envelope) {
        try {
            await this.replicateHost(sessionId, envelope);
        }
        catch (error) {
            this.ctx.logger.warn(`agents-anywhere bridge failed to replicate Host status: ${String(error)}`);
        }
    }
    async publishReplicaEvent(agent, sessionId, event) {
        await this.publishReplica({ type: 'session/event', sessionId, event });
        if (agent === undefined || event.type !== 'agent/inbox/spliced')
            return;
        const project = (target) => {
            const messages = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep;
            return event.data.target === target
                ? messages.toSpliced(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
                : messages;
        };
        await this.publishReplica({
            type: 'session/queue',
            sessionId,
            items: [
                ...project('next-turn').map(message => ({ id: message.id, placement: 'queued', message })),
                ...project('next-step').map(message => ({
                    id: message.id,
                    placement: message.source.kind === 'user' ? 'steering' : 'context',
                    message,
                })),
            ],
        });
    }
    async publishReplica(payload) {
        try {
            await this.replicate(payload.sessionId, bridgeMuxEnvelope(payload));
        }
        catch (error) {
            this.ctx.logger.warn(`agents-anywhere bridge failed to replicate a Web frame: ${String(error)}`);
        }
    }
    /** Exact controller ownership check used by approval and question routing. */
    controllerForAgent(agent) {
        const controller = this.controllers.get(agent.id);
        return controller?.agent === agent && this.ctx.agents.get(agent.id) === agent ? controller : undefined;
    }
    /** Discover materialized DSH Sessions with stable signed pagination. */
    async listSessions(limit, cursor, _force, signal) {
        const snapshots = await this.ctx.sessionPersistence.listSnapshots(signal);
        await this.detectConcurrentWriters(snapshots);
        const archivedSessionIds = this.archivedSessionIds();
        const metas = await Promise.all(snapshots.map(snapshot => this.metaFor(snapshot, archivedSessionIds, signal)));
        const fingerprint = contentHash(metas.map(item => [item.externalSessionId, item.revision]));
        metas.sort((left, right) => right.orderingTime.localeCompare(left.orderingTime)
            || left.externalSessionId.localeCompare(right.externalSessionId));
        let start = 0;
        if (cursor !== undefined) {
            const decoded = this.decodeCursor(cursor);
            if (decoded.fingerprint !== fingerprint) {
                throw new BridgeError('SESSION_CONFLICT', 'The Session list changed; restart pagination.', { retryable: true });
            }
            const index = metas.findIndex(item => item.orderingTime === decoded.orderingTime
                && item.externalSessionId === decoded.externalSessionId);
            if (index === -1)
                throw new BridgeError('INVALID_PARAMS', 'Session cursor is no longer valid.', { retryable: true });
            start = index + 1;
        }
        const sessions = metas.slice(start, start + limit);
        const last = sessions.at(-1);
        const nextCursor = start + sessions.length < metas.length && last !== undefined
            ? this.encodeCursor({ fingerprint, orderingTime: last.orderingTime, externalSessionId: last.externalSessionId })
            : null;
        return { sessions, nextCursor };
    }
    /** Return a suffix projection without taking a live Agent handle. */
    async snapshot(platformSessionId, externalSessionId, fromSeq, eventLimit, signal) {
        await this.ensureBinding(platformSessionId, externalSessionId);
        const { meta, events } = await this.ctx.sessionPersistence.readFrom(SessionId(externalSessionId), fromSeq, signal);
        const selectedEvents = events.slice(0, eventLimit);
        const snapshots = await this.ctx.sessionPersistence.listSnapshots(signal);
        const snapshot = snapshots.find(item => item.header.id === meta.id);
        const inspection = await this.ctx.sessionPersistence.inspect(meta.id, signal);
        const visibility = sessionVisibility(inspection.meta, inspection.events, this.archivedSessionIds());
        const revision = snapshot === undefined ? undefined : sessionSyncRevision(snapshot.revision, visibility);
        return {
            sessionId: platformSessionId,
            externalSessionId,
            runtime: RUNTIME_ID,
            items: projectTimeline(meta, selectedEvents, false),
            complete: selectedEvents.length === events.length,
            watermark: timelineWatermark(selectedEvents, fromSeq, revision === undefined ? undefined : String(revision)),
        };
    }
    /** Return live or cold Session state without resuming a cold Agent. */
    async state(platformSessionId, externalSessionId, signal) {
        await this.ensureBinding(platformSessionId, externalSessionId);
        const controller = this.controllers.get(SessionId(externalSessionId))
            ?? await this.coldController(platformSessionId, externalSessionId, signal);
        const state = controller.state();
        return state === undefined ? null : state;
    }
    /** Return open interaction notices for one Session. */
    async notices(platformSessionId, externalSessionId) {
        await this.ensureBinding(platformSessionId, externalSessionId);
        return {
            sessionId: platformSessionId,
            externalSessionId,
            notices: this.interactions?.notices(platformSessionId) ?? [],
        };
    }
    /** Return capabilities using live or cold state and current model validity. */
    async capabilities(platformSessionId, externalSessionId, signal) {
        await this.ensureBinding(platformSessionId, externalSessionId);
        const controller = this.controllers.get(SessionId(externalSessionId))
            ?? await this.coldController(platformSessionId, externalSessionId, signal);
        const state = controller.state();
        if (state === undefined)
            throw new Error(`Session ${externalSessionId} lost its AA binding`);
        return {
            sessionId: platformSessionId,
            externalSessionId,
            runtime: RUNTIME_ID,
            revision: state.revision,
            capabilities: sessionCapabilities(platformSessionId, state.status, await this.modelAvailable(controller)),
        };
    }
    /** Create a native DSH Session, deliver its first message, and await durability. */
    async createAndStart(operation, signal) {
        if (operation.attachments.length > 0) {
            throw new BridgeError('UNSUPPORTED_OPERATION', 'Attachments are not supported by bridge protocol 1.0.', { retryable: false });
        }
        const cwd = await validateWorkspace(operation.cwd);
        const reservation = await this.metadata.reserveCreation(operation.sessionId, operation.clientMessageId);
        const externalSessionId = reservation.externalSessionId;
        const existingBinding = this.metadata.bindingForPlatform(operation.sessionId);
        if (existingBinding !== undefined && existingBinding.externalSessionId !== externalSessionId) {
            throw new BridgeError('SESSION_BINDING_CONFLICT', 'The AA Session is already bound to another DSH Session.', {
                retryable: false,
                sessionId: operation.sessionId,
                externalSessionId,
            });
        }
        const existingSnapshot = (await this.ctx.sessionPersistence.listSnapshots(signal))
            .find(item => String(item.header.id) === externalSessionId);
        if (reservation.committed && existingSnapshot !== undefined) {
            await this.verifyCommittedCreate(operation.sessionId, operation.clientMessageId, operation.content, existingSnapshot.header.id, signal);
            await this.metadata.bind(operation.sessionId, externalSessionId);
            return receipt(operation.sessionId, externalSessionId, operation.clientMessageId, true);
        }
        const model = await this.requestedModel(operation.selections);
        const permission = await this.requestedPermission(operation.selections);
        let controller = this.controllers.get(SessionId(externalSessionId));
        if (controller === undefined) {
            controller = new SessionController(SessionId(externalSessionId), operation.sessionId, model, permissionSelectionId(permission), item => this.onControllerState(item));
            this.controllers.set(SessionId(externalSessionId), controller);
        }
        return await controller.enqueue(async () => {
            try {
                if (controller.agent === undefined) {
                    const materialized = existingSnapshot ?? (await this.ctx.sessionPersistence.listSnapshots(signal))
                        .find(item => String(item.header.id) === externalSessionId);
                    if (materialized === undefined) {
                        const handle = await this.ctx.agents.create({
                            sessionId: SessionId(externalSessionId),
                            meta: { cwd },
                            agentOptions: { provider: model.provider, model: model.model },
                            ...(signal === undefined ? {} : { signal }),
                            setup: agentCtx => { installModelSelection(agentCtx, controller.selection); },
                        });
                        controller.attach(handle);
                    }
                    else {
                        await this.resume(controller, signal);
                    }
                }
                const agent = controller.requireLive(id => this.ctx.agents.get(id));
                if (this.ctx.permissionPresets.current(agent.session.events) !== permission) {
                    this.ctx.permissionPresets.set(agent.session, permission);
                    controller.permissionSelectionId = permissionSelectionId(permission);
                }
                await this.metadata.bind(operation.sessionId, externalSessionId);
                const submission = await this.submitMessage(controller, 'create', operation.content, operation.clientMessageId, false);
                await this.metadata.commitCreation(reservation);
                const snapshot = (await this.ctx.sessionPersistence.listSnapshots())
                    .find(item => String(item.header.id) === externalSessionId);
                if (snapshot !== undefined) {
                    await this.emit('session.meta.upsert', await this.metaFor(snapshot, this.archivedSessionIds()));
                }
                return receipt(operation.sessionId, externalSessionId, operation.clientMessageId, submission.duplicate);
            }
            catch (error) {
                const handle = controller.handle;
                if (handle !== undefined) {
                    handle.agent.cancel({ kind: 'disposed' }, { keepInbox: false });
                    await handle.agent.whenIdle().catch(() => undefined);
                    await this.ctx.sessions.flush(handle.agent.session).catch(() => undefined);
                    await controller.dispose().catch(() => undefined);
                }
                await controller.transition('error', { code: 'CREATE_FAILED', message: 'DSH Session creation did not complete.' });
                throw error;
            }
        });
    }
    /** Start one ordinary follow-up turn on an idle Session. */
    async startTurn(operation, signal) {
        const controller = await this.writableController(operation.sessionId, operation.externalSessionId, signal);
        return await controller.enqueue(async () => {
            await this.checkRevision(controller, signal);
            const agent = await this.resume(controller, signal);
            if (agent.status !== 'idle' || controller.status !== 'idle')
                throw sessionConflict(controller, 'start a turn');
            await this.applySelections(controller, operation.selections);
            if (!await this.modelAvailable(controller)) {
                throw new BridgeError('INVALID_SELECTION', 'Select a model that is available before starting a turn.', {
                    retryable: false,
                    sessionId: operation.sessionId,
                    externalSessionId: operation.externalSessionId,
                });
            }
            await controller.transition('pending');
            let result;
            try {
                result = await this.submitMessage(controller, 'start', operation.content, operation.clientMessageId, false);
            }
            catch (error) {
                await controller.transition('error', { code: 'MESSAGE_SUBMIT_FAILED', message: 'The message was not durably accepted.' });
                throw error;
            }
            if (result.duplicate)
                await controller.transition(agent.status);
            return receipt(operation.sessionId, operation.externalSessionId, operation.clientMessageId, result.duplicate);
        });
    }
    /** Queue steering for the next step of a running Agent. */
    async steer(operation, signal) {
        const controller = await this.writableController(operation.sessionId, operation.externalSessionId, signal);
        return await controller.enqueue(async () => {
            await this.checkRevision(controller, signal);
            const agent = controller.requireLive(id => this.ctx.agents.get(id));
            if (agent.status !== 'running' || controller.status !== 'running')
                throw sessionConflict(controller, 'steer');
            const result = await this.submitMessage(controller, 'steer', operation.content, operation.clientMessageId, true);
            return receipt(operation.sessionId, operation.externalSessionId, operation.clientMessageId, result.duplicate);
        });
    }
    /** Interrupt running work and converge to idle. */
    async interrupt(platformSessionId, externalSessionId) {
        const controller = await this.writableController(platformSessionId, externalSessionId);
        return await controller.enqueue(async () => {
            const agent = controller.agent;
            if (agent === undefined || agent.status === 'idle') {
                await controller.transition('idle');
                return { ok: true, duplicate: true };
            }
            await controller.transition('stopping');
            await this.interactions?.cancelFor(controller);
            agent.cancel({ kind: 'user' }, { keepInbox: false });
            await agent.whenIdle();
            await this.ctx.sessions.flush(agent.session);
            await this.observeRevision(controller);
            await controller.transition('idle');
            return { ok: true, duplicate: false };
        });
    }
    /** Update idle model and permission selection for the next step. */
    async updateSelections(platformSessionId, externalSessionId, selections, signal) {
        const controller = await this.writableController(platformSessionId, externalSessionId, signal);
        return await controller.enqueue(async () => {
            await this.checkRevision(controller, signal);
            const agent = await this.resume(controller, signal);
            if (agent.status !== 'idle' || controller.status !== 'idle')
                throw sessionConflict(controller, 'update selections');
            await this.applySelections(controller, selections);
            await this.ctx.sessions.flush(agent.session);
            await this.observeRevision(controller, signal);
            return { ok: true, selections: controller.state()?.selections };
        });
    }
    /** Resume if needed and list effective Session commands. */
    async listCommands(platformSessionId, externalSessionId, query, limit, signal) {
        const controller = await this.writableController(platformSessionId, externalSessionId, signal);
        return await controller.enqueue(async () => {
            const agent = await this.resume(controller, signal);
            if (agent.status !== 'idle')
                throw sessionConflict(controller, 'list commands');
            const normalized = query?.toLocaleLowerCase();
            const commands = this.ctx.commands.list(agent)
                .filter(item => normalized === undefined
                || item.name.toLocaleLowerCase().includes(normalized)
                || item.description.toLocaleLowerCase().includes(normalized))
                .slice(0, limit)
                .map(item => ({
                name: item.name,
                description: item.description,
                acceptsArgs: item.input !== undefined,
                ...(item.input === undefined ? {} : { inputHint: item.input.hint }),
            }));
            return { commands };
        });
    }
    /** Execute one canonical DSH command while idle. */
    async executeCommand(platformSessionId, externalSessionId, command, raw, args, signal) {
        const controller = await this.writableController(platformSessionId, externalSessionId, signal);
        return await controller.enqueue(async () => {
            await this.checkRevision(controller, signal);
            const agent = await this.resume(controller, signal);
            if (agent.status !== 'idle' || controller.status !== 'idle')
                throw sessionConflict(controller, 'execute a command');
            const line = raw ?? `/${command}${args.length === 0 ? '' : ` ${args}`}`;
            const result = await this.ctx.commands.execute(agent, line, signal);
            if (result === undefined) {
                throw new BridgeError('COMMAND_NOT_FOUND', 'The command is not registered for this Session.', {
                    retryable: false,
                    sessionId: platformSessionId,
                    externalSessionId,
                });
            }
            await this.ctx.sessions.flush(agent.session);
            await this.observeRevision(controller, signal);
            return { ok: result.result.kind === 'success', commandId: String(result.commandId), result: result.result };
        });
    }
    /** Validate and settle one interaction through the owning Session queue. */
    async respondInteraction(platformSessionId, externalSessionId, noticeId, actionId, inputData, signal) {
        const controller = await this.writableController(platformSessionId, externalSessionId, signal);
        return await controller.enqueue(async () => await this.interactionsOrThrow().respond(platformSessionId, noticeId, actionId, inputData));
    }
    /** Flush, cancel, and dispose every owned Agent handle. */
    async shutdown() {
        let disposedSessions = 0;
        let failedSessions = 0;
        const failures = [];
        await Promise.all([...this.controllers.values()].map(controller => controller.enqueue(async () => {
            try {
                const handle = controller.handle;
                if (handle !== undefined) {
                    if (handle.agent.status === 'running') {
                        handle.agent.cancel({ kind: 'disposed' }, { keepInbox: false });
                        await handle.agent.whenIdle();
                    }
                    await this.ctx.sessions.flush(handle.agent.session);
                }
                await controller.dispose();
                disposedSessions += 1;
            }
            catch (error) {
                failedSessions += 1;
                failures.push(error);
            }
        })));
        if (failures.length > 0) {
            const aggregate = new AggregateError(failures, `${failures.length} DSH Session teardown operation(s) failed`);
            process.stderr.write(`[aa-dsh-bridge] ${aggregate.name}: ${aggregate.message}\n`);
        }
        return { disposedSessions, failedSessions };
    }
    /** Reject handoff while the Agent, inbox, serialized queue, or interactions are active. */
    async assertHandoffReady(sessionId) {
        const controller = this.controllers.get(sessionId);
        await controller?.drain();
        const agent = this.ctx.agents.get(sessionId);
        if (agent?.status === 'running'
            || (agent !== undefined && (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0))
            || (controller !== undefined && controller.pendingInteractionIds.size > 0)
            || (controller !== undefined && !['idle', 'error'].includes(controller.status))) {
            throw new BridgeError('SESSION_CONFLICT', `Session "${sessionId}" still has active work, queued input, or a pending interaction`, {
                retryable: true,
                externalSessionId: String(sessionId),
            });
        }
    }
    /** Resume a Session assigned to this process by an explicit handoff. */
    async activate(sessionId) {
        const binding = this.metadata.bindingForExternal(String(sessionId));
        const controller = this.controllers.get(sessionId)
            ?? await this.coldController(binding?.platformSessionId, String(sessionId));
        await controller.enqueue(async () => { await this.resume(controller); });
    }
    /** Return the Web queue, interactions, and status for a follower baseline. */
    webBaseline(sessionId) {
        const agent = this.ctx.agents.get(sessionId);
        const mux = [bridgeMuxEnvelope({
                type: 'session/queue',
                sessionId,
                items: agent === undefined ? [] : [
                    ...agent.inbox.nextTurn.map(message => ({ id: message.id, placement: 'queued', message })),
                    ...agent.inbox.nextStep.map(message => ({
                        id: message.id,
                        placement: message.source.kind === 'user' ? 'steering' : 'context',
                        message,
                    })),
                ],
            })];
        mux.push(...(this.interactions?.webBaselines(sessionId) ?? []));
        return {
            mux,
            host: [bridgeHostEnvelope({
                    type: 'host/session-status',
                    sessionId,
                    running: agent?.status === 'running',
                })],
        };
    }
    /** Project one remote owner's Web mux envelope into AA notifications. */
    async consumeWebMux(envelope) {
        const payload = envelope.payload;
        const binding = this.metadata.bindingForExternal(String(payload.sessionId));
        if (binding === undefined)
            return;
        if (payload.type === 'approval/requested' || payload.type === 'approval/resolved'
            || payload.type === 'question/requested' || payload.type === 'question/resolved') {
            await this.interactions?.consumeWebEnvelope(binding.platformSessionId, envelope);
            return;
        }
        if (payload.type !== 'session/event')
            return;
        let history = this.replicaHistories.get(payload.sessionId);
        if (history === undefined) {
            const inspected = await this.ctx.sessionPersistence.inspect(payload.sessionId);
            history = { header: inspected.meta, events: [...inspected.events] };
            this.replicaHistories.set(payload.sessionId, history);
        }
        if (!history.events.some(event => event.seq === payload.event.seq)) {
            history.events.push(payload.event);
            history.events.sort((left, right) => left.seq - right.seq);
        }
        const controller = this.controllers.get(payload.sessionId)
            ?? await this.coldController(binding.platformSessionId, String(payload.sessionId));
        await this.publishEvent(controller, history.header, history.events, payload.event);
    }
    /** Project one remote owner's Host status envelope into AA state. */
    async consumeWebHost(envelope) {
        const payload = envelope.payload;
        const binding = this.metadata.bindingForExternal(String(payload.sessionId));
        if (binding === undefined)
            return;
        const controller = this.controllers.get(payload.sessionId)
            ?? await this.coldController(binding.platformSessionId, String(payload.sessionId));
        if (payload.type === 'host/session-status') {
            await controller.transition(payload.running ? 'running' : 'idle');
            return;
        }
        await controller.transition('error', { code: 'DSH_AGENT_ERROR', message: payload.message });
    }
    /** Accept one Web prompt in the process that currently owns its Agent. */
    async apiPrompt(input) {
        const controller = await this.apiController(input.sessionId);
        return controller.enqueue(async () => {
            const agent = await this.resume(controller);
            const canonicalTimeZone = input.clientTimeZone === undefined
                ? undefined
                : canonicalTimeZoneOf(input.clientTimeZone);
            if (input.clientTimeZone !== undefined && canonicalTimeZone === undefined) {
                throw new BridgeError('INVALID_PARAMS', 'clientTimeZone must be UTC or a valid IANA Area/Location name.', { retryable: false });
            }
            const clientContentHash = contentHash({ mode: input.mode, content: input.content });
            const existing = [...agent.session.events]
                .filter((event) => event.type === 'user/message')
                .map(event => event.data)
                .concat(agent.inbox.nextTurn, agent.inbox.nextStep)
                .find(message => messageSourceId(message.source) === input.clientMessageId);
            if (existing !== undefined) {
                const source = existing.source;
                if (source.clientContentHash !== clientContentHash) {
                    throw new BridgeError('IDEMPOTENCY_CONFLICT', 'clientMessageId was already used for different Web prompt content.', {
                        retryable: false,
                        externalSessionId: String(input.sessionId),
                    });
                }
                return { accepted: true };
            }
            const content = await durablePromptContent(this.ctx, input.content);
            const message = freezeMessage({
                id: MessageId(deterministicMessageId(String(input.sessionId), input.clientMessageId)),
                role: 'user',
                content,
                source: {
                    kind: 'user',
                    rpcId: input.rpcId,
                    clientMessageId: input.clientMessageId,
                    clientContentHash,
                    ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
                },
            });
            if (input.mode === 'steer')
                agent.steer(message);
            else
                agent.followup(message);
            await this.ctx.sessions.flush(agent.session);
            await this.observeRevision(controller);
            return { accepted: true };
        });
    }
    /** Mutate one pending Web queue item on the owner process. */
    async apiUpdateQueue(sessionId, itemId, action) {
        const controller = await this.apiController(sessionId);
        return controller.enqueue(async () => {
            const agent = await this.resume(controller);
            const message = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
                .find(candidate => String(candidate.id) === itemId);
            if (message === undefined)
                throw new BridgeError('SESSION_CONFLICT', 'The queued item is no longer pending.', { retryable: true });
            if (action.kind === 'edit') {
                if (action.content === undefined || action.content.some(block => block.type !== 'text')) {
                    throw new BridgeError('INVALID_PARAMS', 'Queue edits accept text content only.', { retryable: false });
                }
                agent.inbox.replace(message.id, freezeMessage({ ...message, content: action.content }));
            }
            else {
                agent.inbox.remove(message.id);
                if (action.kind === 'steer')
                    agent.steer(message);
            }
            return { accepted: true };
        });
    }
    /** Cancel the owner process's active Web turn while preserving queued work. */
    async apiCancel(sessionId) {
        const controller = await this.apiController(sessionId);
        return controller.enqueue(async () => {
            const agent = await this.resume(controller);
            agent.cancel({ kind: 'user' }, { keepInbox: true });
            return { accepted: true };
        });
    }
    /** Return the owner process's model selection and current catalog. */
    async apiModels(sessionId) {
        const controller = await this.apiController(sessionId);
        return controller.enqueue(async () => {
            await this.resume(controller);
            const snapshot = await this.catalogs.current();
            const current = controller.selection.current;
            if (current === undefined)
                throw new Error('Session controller has no model selection');
            const providers = new Map();
            for (const item of snapshot.models) {
                let models = providers.get(item.provider);
                if (models === undefined) {
                    models = new Map();
                    providers.set(item.provider, models);
                }
                const efforts = models.get(item.model) ?? [];
                efforts.push(item);
                models.set(item.model, efforts);
            }
            return {
                current: { ...current },
                routable: this.ctx.llm.listProviders().some(provider => provider.id === current.provider),
                groups: [...providers].map(([provider, models]) => ({
                    id: provider,
                    name: provider,
                    models: [...models].map(([model, items]) => ({
                        id: model,
                        name: items[0]?.name ?? model,
                        ...(items[0]?.description === undefined ? {} : { description: items[0].description }),
                        reasoning: items.some(item => item.reasoningEffort !== null)
                            ? {
                                efforts: items.flatMap(item => item.reasoningEffort === null
                                    ? []
                                    : [{ id: item.reasoningEffort, name: item.name }]),
                            }
                            : undefined,
                    })),
                })),
                failures: [],
            };
        });
    }
    /** Change the owner process's model selection for the next request. */
    async apiSelectModel(sessionId, selection) {
        const controller = await this.apiController(sessionId);
        return controller.enqueue(async () => {
            await this.resume(controller);
            const selected = await this.catalogs.resolveModel(modelSelectionId(selection));
            await controller.updateModel(selected);
            return { selected: { ...selected } };
        });
    }
    /** Append a user-pinned title through the canonical Session title service. */
    async apiRename(sessionId, title) {
        const controller = await this.apiController(sessionId);
        return controller.enqueue(async () => {
            const agent = await this.resume(controller);
            const accepted = this.ctx.sessionTitle.rename(agent.session, title);
            return { title: accepted.title, seq: accepted.eventSeq };
        });
    }
    /** Return command descriptors from the owner process's effective registry. */
    async apiCommands(sessionId) {
        const controller = await this.apiController(sessionId);
        return controller.enqueue(async () => {
            const agent = await this.resume(controller);
            return { commands: this.ctx.commands.list(agent) };
        });
    }
    /** Execute one complete slash-command line on the owner process. */
    async apiCommand(sessionId, line, signal) {
        const controller = await this.apiController(sessionId);
        return controller.enqueue(async () => {
            const agent = await this.resume(controller, signal);
            const execution = await this.ctx.commands.execute(agent, line, signal);
            await this.ctx.sessions.flush(agent.session);
            await this.observeRevision(controller, signal);
            return { execution: execution ?? null };
        });
    }
    async coldController(platformSessionId, externalSessionId, signal) {
        const inspection = await this.ctx.sessionPersistence.inspect(SessionId(externalSessionId), signal);
        const model = await this.selectionFromEvents(inspection.events);
        const permission = this.catalogs.permissionFor(inspection.events);
        const controller = new SessionController(SessionId(externalSessionId), platformSessionId, model, permission, item => this.onControllerState(item));
        const existing = this.controllers.get(SessionId(externalSessionId));
        if (existing !== undefined)
            return existing;
        this.controllers.set(SessionId(externalSessionId), controller);
        return controller;
    }
    async verifyCommittedCreate(platformSessionId, clientMessageId, text, externalSessionId, signal) {
        const expectedHash = sha256Hex(text);
        const record = await this.metadata.message(platformSessionId, clientMessageId);
        if (record !== undefined) {
            if (record.operation !== 'create' || record.contentHash !== expectedHash) {
                throw new BridgeError('IDEMPOTENCY_CONFLICT', 'clientMessageId was already used for different content or an operation.', {
                    retryable: false,
                    sessionId: platformSessionId,
                    externalSessionId: String(externalSessionId),
                });
            }
            return;
        }
        const inspection = await this.ctx.sessionPersistence.inspect(externalSessionId, signal);
        const expectedMessageId = deterministicMessageId(platformSessionId, clientMessageId);
        const message = findPersistedMessage(inspection.events, expectedMessageId);
        if (message === undefined) {
            throw new BridgeError('PERSISTENCE_ERROR', 'A committed creation has no matching DSH message.', {
                retryable: false,
                sessionId: platformSessionId,
                externalSessionId: String(externalSessionId),
            });
        }
        if (!sameHumanMessage(message, text)) {
            throw new BridgeError('IDEMPOTENCY_CONFLICT', 'The deterministic DSH MessageId already contains different content.', {
                retryable: false,
                sessionId: platformSessionId,
                externalSessionId: String(externalSessionId),
            });
        }
        await this.metadata.recordMessage({
            platformSessionId,
            clientMessageId,
            operation: 'create',
            contentHash: expectedHash,
        });
    }
    interactionsOrThrow() {
        if (this.interactions === undefined)
            throw new Error('Interaction manager is not attached');
        return this.interactions;
    }
    async writableController(platformSessionId, externalSessionId, signal) {
        await this.ensureBinding(platformSessionId, externalSessionId);
        return this.controllers.get(SessionId(externalSessionId))
            ?? await this.coldController(platformSessionId, externalSessionId, signal);
    }
    async apiController(sessionId) {
        const binding = this.metadata.bindingForExternal(String(sessionId));
        return this.controllers.get(sessionId)
            ?? await this.coldController(binding?.platformSessionId, String(sessionId));
    }
    async resume(controller, signal) {
        if (controller.agent !== undefined) {
            try {
                return controller.requireLive(id => this.ctx.agents.get(id));
            }
            catch (error) {
                await controller.detachStale();
                if (!(error instanceof BridgeError))
                    throw error;
            }
        }
        if (controller.status === 'error') {
            const inspection = await this.ctx.sessionPersistence.inspect(controller.externalSessionId, signal);
            controller.selection.current = await this.selectionFromEvents(inspection.events);
            controller.permissionSelectionId = this.catalogs.permissionFor(inspection.events);
        }
        const existing = this.ctx.agents.get(controller.externalSessionId);
        if (existing !== undefined) {
            controller.attachBorrowed(existing);
            const snapshot = (await this.ctx.sessionPersistence.listSnapshots(signal))
                .find(item => item.header.id === controller.externalSessionId);
            controller.lastObservedRevision = snapshot?.revision;
            controller.localAppendsSinceRevision = 0;
            await controller.transition(existing.status);
            return existing;
        }
        const selection = controller.selection.current;
        if (selection === undefined)
            throw new Error('Session controller has no model selection');
        const handle = await this.ctx.agents.resume({
            resumeSessionId: controller.externalSessionId,
            agentOptions: {
                provider: selection.provider,
                model: selection.model,
            },
            ...(signal === undefined ? {} : { signal }),
            setup: agentCtx => { installModelSelection(agentCtx, controller.selection); },
        });
        controller.attach(handle);
        const snapshot = (await this.ctx.sessionPersistence.listSnapshots(signal))
            .find(item => item.header.id === controller.externalSessionId);
        controller.lastObservedRevision = snapshot?.revision;
        controller.localAppendsSinceRevision = 0;
        await controller.transition(handle.agent.status);
        return handle.agent;
    }
    async submitMessage(controller, operation, text, clientMessageId, steer) {
        const platformSessionId = controller.platformSessionId;
        if (platformSessionId === undefined)
            throw new Error('cannot submit before binding a platform Session');
        const agent = controller.requireLive(id => this.ctx.agents.get(id));
        const expectedMessageId = deterministicMessageId(platformSessionId, clientMessageId);
        const logged = findMessage(agent.session.events, expectedMessageId);
        const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
            .find(message => String(message.id) === expectedMessageId);
        if ((logged !== undefined && !sameHumanMessage(logged.data, text))
            || (pending !== undefined && !sameHumanMessage(pending, text))) {
            throw new BridgeError('IDEMPOTENCY_CONFLICT', 'The deterministic DSH MessageId already contains different content.', {
                retryable: false,
                sessionId: platformSessionId,
                externalSessionId: String(controller.externalSessionId),
            });
        }
        const stored = await this.metadata.recordMessage({
            platformSessionId,
            clientMessageId,
            operation,
            contentHash: sha256Hex(text),
        });
        const alreadyAccepted = logged !== undefined || pending !== undefined;
        if (!alreadyAccepted) {
            const message = freezeMessage({
                id: MessageId(stored.record.messageId),
                role: 'user',
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
            });
            if (steer)
                agent.steer(message);
            else
                agent.followup(message);
        }
        await this.ctx.sessions.flush(agent.session);
        await this.observeRevision(controller);
        return { duplicate: stored.duplicate || alreadyAccepted };
    }
    async applySelections(controller, selections) {
        if (selections === undefined)
            return;
        const model = selections.model === undefined ? undefined : await this.catalogs.resolveModel(selections.model);
        const permission = selections.permission === undefined ? undefined : await this.catalogs.resolvePermission(selections.permission);
        const agent = controller.requireLive(id => this.ctx.agents.get(id));
        if (model !== undefined)
            await controller.updateModel(model);
        if (permission !== undefined) {
            this.ctx.permissionPresets.set(agent.session, permission);
            await controller.updatePermission(permissionSelectionId(permission));
        }
    }
    async requestedModel(selections) {
        return selections?.model === undefined ? await this.catalogs.defaultModel() : await this.catalogs.resolveModel(selections.model);
    }
    async requestedPermission(selections) {
        if (selections?.permission !== undefined)
            return await this.catalogs.resolvePermission(selections.permission);
        return this.ctx.permissionPresets.defaultPreset;
    }
    async selectionFromEvents(events) {
        const header = events.findLast(event => event.type === 'request/header');
        if (header === undefined)
            return await this.catalogs.defaultModel();
        const config = header.data.header.config;
        return {
            provider: config.provider,
            model: config.model,
            ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
        };
    }
    async ensureBinding(platformSessionId, externalSessionId) {
        const byPlatform = this.metadata.bindingForPlatform(platformSessionId);
        const byExternal = this.metadata.bindingForExternal(externalSessionId);
        if ((byPlatform !== undefined && byPlatform.externalSessionId !== externalSessionId)
            || (byExternal !== undefined && byExternal.platformSessionId !== platformSessionId)) {
            throw new BridgeError('SESSION_BINDING_CONFLICT', 'The supplied AA and DSH Session IDs do not match.', {
                retryable: false,
                sessionId: platformSessionId,
                externalSessionId,
            });
        }
        const exists = (await this.ctx.sessionPersistence.listSnapshots())
            .some(item => String(item.header.id) === externalSessionId);
        if (!exists) {
            throw new BridgeError('SESSION_NOT_FOUND', 'The DSH Session does not exist.', {
                retryable: false,
                sessionId: platformSessionId,
                externalSessionId,
            });
        }
        if (byPlatform === undefined)
            await this.metadata.bind(platformSessionId, externalSessionId);
    }
    async metaFor(snapshot, archivedSessionIds, signal) {
        const inspection = await this.ctx.sessionPersistence.inspect(snapshot.header.id, signal);
        const title = foldSessionTitle(inspection.events)?.title ?? null;
        const orderingTime = new Date(inspection.events.at(-1)?.time ?? snapshot.header.createdAt).toISOString();
        const visibility = sessionVisibility(snapshot.header, inspection.events, archivedSessionIds);
        return {
            sessionId: this.metadata.bindingForExternal(String(snapshot.header.id))?.platformSessionId ?? null,
            externalSessionId: String(snapshot.header.id),
            runtime: RUNTIME_ID,
            title,
            cwd: snapshot.header.cwd ?? null,
            orderingTime,
            revision: sessionSyncRevision(snapshot.revision, visibility),
            requiresTimelineSync: !visibility.hidden,
            metadata: visibility,
        };
    }
    archivedSessionIds() {
        return new Set(this.ctx.workspaceRegistry.archivedSessionIds);
    }
    async publishEvent(controller, header, events, event) {
        const platformSessionId = controller.platformSessionId;
        if (platformSessionId === undefined)
            return;
        if (event.type === 'session/title') {
            const snapshots = await this.ctx.sessionPersistence.listSnapshots();
            const snapshot = snapshots.find(item => item.header.id === header.id);
            if (snapshot !== undefined) {
                await this.emit('session.meta.upsert', await this.metaFor(snapshot, this.archivedSessionIds()));
            }
        }
        const projected = projectTimeline(header, events, true);
        const candidates = projectedItemsForEvent(projected, header, event);
        for (const candidate of candidates) {
            await this.emit('timeline.item.upsert', {
                sessionId: platformSessionId,
                externalSessionId: String(controller.externalSessionId),
                runtime: RUNTIME_ID,
                item: candidate,
            });
        }
    }
    async onControllerState(controller) {
        const state = controller.state();
        if (state === undefined)
            return;
        await this.emit('session.state.update', state);
        await this.emit('session.capabilities.update', {
            sessionId: state.sessionId,
            externalSessionId: state.externalSessionId,
            runtime: RUNTIME_ID,
            revision: state.revision,
            capabilities: sessionCapabilities(state.sessionId, state.status, await this.modelAvailable(controller)),
        });
    }
    async modelAvailable(controller) {
        const id = modelSelectionId(controller.selection.current);
        return (await this.catalogs.current()).models.some(item => item.selectionId === id && item.enabled);
    }
    async checkRevision(controller, signal) {
        if (controller.agent === undefined || controller.lastObservedRevision === undefined)
            return;
        const observed = await this.revisionOf(controller.externalSessionId, signal);
        if (observed !== undefined && observed !== controller.lastObservedRevision && controller.localAppendsSinceRevision === 0) {
            await this.quarantineConcurrentWriter(controller, observed);
            await this.emit('runtime.error', {
                runtime: RUNTIME_ID,
                code: 'DSH_CONCURRENT_WRITER_DETECTED',
                message: 'The persisted DSH Session changed outside this bridge process.',
                ...(controller.platformSessionId === undefined ? {} : { sessionId: controller.platformSessionId }),
                externalSessionId: String(controller.externalSessionId),
            });
            throw new BridgeError('DSH_CONCURRENT_WRITER_DETECTED', 'A concurrent DSH Session writer was detected.', {
                retryable: false,
                ...(controller.platformSessionId === undefined ? {} : { sessionId: controller.platformSessionId }),
                externalSessionId: String(controller.externalSessionId),
            });
        }
    }
    async observeRevision(controller, signal) {
        controller.lastObservedRevision = await this.revisionOf(controller.externalSessionId, signal);
        controller.localAppendsSinceRevision = 0;
    }
    async detectConcurrentWriters(snapshots) {
        for (const controller of this.controllers.values()) {
            if (controller.agent === undefined || controller.lastObservedRevision === undefined)
                continue;
            const observed = snapshots.find(item => item.header.id === controller.externalSessionId)?.revision;
            if (observed === undefined || observed === controller.lastObservedRevision)
                continue;
            if (controller.localAppendsSinceRevision > 0) {
                controller.lastObservedRevision = observed;
                controller.localAppendsSinceRevision = 0;
                continue;
            }
            await this.quarantineConcurrentWriter(controller, observed);
            await this.emit('runtime.error', {
                runtime: RUNTIME_ID,
                code: 'DSH_CONCURRENT_WRITER_DETECTED',
                message: 'The persisted DSH Session changed outside this bridge process.',
                ...(controller.platformSessionId === undefined ? {} : { sessionId: controller.platformSessionId }),
                externalSessionId: String(controller.externalSessionId),
            });
        }
    }
    async quarantineConcurrentWriter(controller, observed) {
        const agent = controller.agent;
        if (agent !== undefined) {
            agent.cancel({ kind: 'disposed' }, { keepInbox: false });
            await agent.whenIdle().catch(() => undefined);
            if (controller.handle !== undefined)
                await controller.dispose().catch(() => undefined);
            else
                await controller.detachStale();
        }
        controller.lastObservedRevision = observed;
        controller.localAppendsSinceRevision = 0;
        await controller.transition('error', {
            code: 'DSH_CONCURRENT_WRITER_DETECTED',
            message: 'The persisted DSH Session changed outside this bridge process.',
        });
    }
    async revisionOf(id, signal) {
        return (await this.ctx.sessionPersistence.listSnapshots(signal)).find(item => item.header.id === id)?.revision;
    }
    encodeCursor(value) {
        const body = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
        const signature = createHmac('sha256', this.cursorKey).update(body).digest('base64url');
        return `${body}.${signature}`;
    }
    decodeCursor(cursor) {
        const [body, signature, extra] = cursor.split('.');
        if (body === undefined || signature === undefined || extra !== undefined)
            throw invalidCursor();
        const expected = createHmac('sha256', this.cursorKey).update(body).digest('base64url');
        const receivedBytes = Buffer.from(signature);
        const expectedBytes = Buffer.from(expected);
        if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes))
            throw invalidCursor();
        try {
            const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (typeof value.fingerprint !== 'string' || typeof value.orderingTime !== 'string'
                || typeof value.externalSessionId !== 'string')
                throw invalidCursor();
            return value;
        }
        catch (error) {
            if (error instanceof BridgeError)
                throw error;
            throw invalidCursor();
        }
    }
}
function invalidCursor() {
    return new BridgeError('INVALID_PARAMS', 'Session cursor is invalid.', { retryable: false });
}
async function validateWorkspace(value) {
    if (!isAbsolute(value))
        throw new BridgeError('INVALID_PARAMS', 'cwd must be an absolute path.', { retryable: false });
    let resolved;
    try {
        resolved = await realpath(value);
        if (!(await stat(resolved)).isDirectory())
            throw new Error('not a directory');
    }
    catch {
        throw new BridgeError('INVALID_PARAMS', 'cwd must identify an accessible directory.', { retryable: false });
    }
    return resolved;
}
function canonicalTimeZoneOf(value) {
    if (value === 'UTC')
        return value;
    if (!value.includes('/'))
        return undefined;
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
    }
    catch {
        return undefined;
    }
}
function messageSourceId(source) {
    return typeof source === 'object' && source !== null && 'clientMessageId' in source
        && typeof source.clientMessageId === 'string'
        ? source.clientMessageId
        : undefined;
}
function decodeBase64(data) {
    const decoded = Buffer.from(data, 'base64');
    if (data.length === 0 || decoded.toString('base64') !== data) {
        throw new AttachmentError('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64');
    }
    return new Uint8Array(decoded);
}
async function durablePromptContent(ctx, content) {
    if (content.every(part => part.type === 'text')) {
        return content.map(part => ({ type: 'text', text: part.text }));
    }
    const limits = ctx.attachments.imageLimits;
    if (content.filter(part => part.type === 'image').length > limits.maxImagesPerMessage) {
        throw new AttachmentError('Prompt exceeds the configured image-count limit.', 'TOO_MANY_IMAGES');
    }
    const prepared = content.map(part => part.type === 'text' ? part : { part, data: decodeBase64(part.data) });
    const images = prepared.filter((part) => 'data' in part);
    if (images.reduce((sum, image) => sum + image.data.byteLength, 0) > limits.maxMessageImageBytes) {
        throw new AttachmentError('Prompt exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE');
    }
    for (const image of images) {
        await ctx.attachments.validateImage({
            data: image.data,
            mediaType: image.part.mediaType,
            ...(image.part.name === undefined ? {} : { name: image.part.name }),
        });
    }
    const blocks = [];
    for (const item of prepared) {
        if (!('data' in item)) {
            blocks.push({ type: 'text', text: item.text });
            continue;
        }
        const attachment = await ctx.attachments.saveImage({
            data: item.data,
            mediaType: item.part.mediaType,
            ...(item.part.name === undefined ? {} : { name: item.part.name }),
        });
        blocks.push({ type: 'image', attachment });
    }
    return blocks;
}
function findMessage(events, messageId) {
    return events.find((event) => event.type === 'user/message' && String(event.data.id) === messageId);
}
function findPersistedMessage(events, messageId) {
    for (const event of events) {
        if (event.type === 'user/message' && String(event.data.id) === messageId)
            return event.data;
        if (event.type === 'agent/inbox/spliced') {
            const inserted = event.data.inserted.find(message => String(message.id) === messageId);
            if (inserted !== undefined)
                return inserted;
        }
    }
    return undefined;
}
function sameHumanMessage(message, text) {
    return message.source.kind === 'user'
        && message.content.length === 1
        && message.content[0]?.type === 'text'
        && message.content[0].text === text;
}
function receipt(sessionId, externalSessionId, clientMessageId, duplicate) {
    return {
        ok: true,
        result: { sessionId, externalSessionId, clientMessageId, accepted: true, duplicate },
    };
}
function sessionConflict(controller, operation) {
    return new BridgeError('SESSION_CONFLICT', `The Session cannot ${operation} in its current state.`, {
        retryable: true,
        ...(controller.platformSessionId === undefined ? {} : { sessionId: controller.platformSessionId }),
        externalSessionId: String(controller.externalSessionId),
    });
}
function projectedItemsForEvent(items, header, event) {
    const externalSessionId = String(header.id);
    const ids = [];
    switch (event.type) {
        case 'user/message':
            ids.push(timelineItemId(externalSessionId, 'message', String(event.data.id)));
            break;
        case 'assistant/message':
            ids.push(timelineItemId(externalSessionId, 'assistant_activity', `${event.data.turn}:${event.data.step}`));
            ids.push(timelineItemId(externalSessionId, 'message', String(event.data.message.id)));
            break;
        case 'assistant/chunk':
            ids.push(timelineItemId(externalSessionId, 'assistant_activity', `${event.data.turn}:${event.data.step}`));
            break;
        case 'tool/call':
            ids.push(timelineItemId(externalSessionId, 'tool_call', String(event.data.callId)));
            break;
        case 'tool/result':
            ids.push(timelineItemId(externalSessionId, 'tool_result', String(event.data.message.content[0].toolCallId)));
            break;
        case 'command/run':
        case 'command/done':
            ids.push(timelineItemId(externalSessionId, 'command', String(event.data.commandId)));
            break;
        case 'turn/start':
        case 'turn/end':
            ids.push(timelineItemId(externalSessionId, 'turn_status', String(event.data.turn)));
            break;
        default:
            break;
    }
    const wanted = new Set(ids);
    return items.filter(item => wanted.has(item.id));
}
//# sourceMappingURL=sessions.js.map