import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { MetadataStore } from '../persistence/metadata.js'
import {
  canonicalJson,
  contentHash,
  deterministicMessageId,
  modelSelectionId,
  permissionSelectionId,
  sha256Hex,
} from '../projection/identity.js'
import { projectTimeline } from '../projection/timeline.js'
import { BridgeError } from '../wire/errors.js'
import { RUNTIME_ID } from '../wire/protocol.js'
import type { OutboundNotificationMethod } from '../wire/protocol.js'
import { sessionCapabilities } from './capabilities.js'
import type { CatalogManager } from './catalogs.js'
import type { InteractionManager } from './interactions.js'
import { SessionController } from './session-controller.js'
import type { TimelineItem } from './types.js'

type NotificationEmitter = (method: OutboundNotificationMethod, params: Record<string, unknown>) => Promise<void>

export interface RequestedSelections {
  model?: string
  permission?: string
}

export interface MessageOperation {
  sessionId: string
  externalSessionId?: string
  content: string
  clientMessageId: string
  selections?: RequestedSelections
}

export class SessionManager {
  private readonly controllers = new Map<SessionId, SessionController>()
  private readonly cursorKey = randomBytes(32)
  private interactions: InteractionManager | undefined

  constructor(
    private readonly ctx: Context,
    private readonly metadata: MetadataStore,
    private readonly catalogs: CatalogManager,
    readonly maxListLimit: number,
    readonly maxCommandLimit: number,
    private readonly emit: NotificationEmitter,
  ) {}

  setInteractions(interactions: InteractionManager): void {
    this.interactions = interactions
  }

  registerObservers(): () => void {
    const disposeStatus = this.ctx.on('agent/status', ({ agent, status }) => {
      const controller = this.controllerForAgent(agent)
      if (controller === undefined || controller.pendingInteractionIds.size > 0 || controller.status === 'stopping') return
      void controller.transition(status).catch(error => this.logNotificationFailure(error))
    })
    const disposeError = this.ctx.on('agent/error', ({ agent, error }) => {
      const controller = this.controllerForAgent(agent)
      if (controller === undefined) return
      void controller.transition('error', {
        code: 'DSH_AGENT_ERROR',
        message: error instanceof Error ? error.message : String(error),
      }).catch(notificationError => this.logNotificationFailure(notificationError))
    })
    const disposeAgent = this.ctx.on('agent/disposed', ({ agent }) => {
      const controller = this.controllers.get(agent.id)
      if (controller?.agent === agent) controller.detachStale()
    })
    const disposeEvent = this.ctx.on('session/event', (session, event) => {
      const controller = this.controllers.get(session.id)
      if (controller === undefined) return
      controller.localAppendsSinceRevision += 1
      void this.publishEvent(controller, session.header, session.events, event)
        .catch(error => this.logNotificationFailure(error))
    })
    return () => {
      disposeStatus()
      disposeError()
      disposeAgent()
      disposeEvent()
    }
  }

  controllerForAgent(agent: Agent): SessionController | undefined {
    const controller = this.controllers.get(agent.id)
    return controller?.agent === agent && this.ctx.agents.get(agent.id) === agent ? controller : undefined
  }

  async listSessions(
    limit: number,
    cursor: string | undefined,
    _force: boolean,
    signal?: AbortSignal,
  ): Promise<{ sessions: Record<string, unknown>[]; nextCursor: string | null }> {
    const snapshots = await this.ctx.sessionPersistence.listSnapshots(signal)
    const metas = await Promise.all(snapshots.map(snapshot => this.metaFor(snapshot, signal)))
    metas.sort((left, right) => String(right.orderingTime).localeCompare(String(left.orderingTime))
      || String(left.externalSessionId).localeCompare(String(right.externalSessionId)))
    const fingerprint = contentHash(metas.map(item => [item.externalSessionId, item.revision]))
    let start = 0
    if (cursor !== undefined) {
      const decoded = this.decodeCursor(cursor)
      if (decoded.fingerprint !== fingerprint) {
        throw new BridgeError('SESSION_CONFLICT', 'The Session list changed; restart pagination.', { retryable: true })
      }
      const index = metas.findIndex(item => item.orderingTime === decoded.orderingTime
        && item.externalSessionId === decoded.externalSessionId)
      if (index === -1) throw invalidCursor()
      start = index + 1
    }
    const sessions = metas.slice(start, start + limit)
    const last = sessions.at(-1)
    const nextCursor = start + sessions.length < metas.length && last !== undefined
      ? this.encodeCursor({
          fingerprint,
          orderingTime: String(last.orderingTime),
          externalSessionId: String(last.externalSessionId),
        })
      : null
    return { sessions, nextCursor }
  }

  async snapshot(
    platformSessionId: string,
    externalSessionId: string,
    fromSeq: number,
    eventLimit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    await this.ensureBinding(platformSessionId, externalSessionId, signal)
    const id = SessionId(externalSessionId)
    const inspection = await this.inspect(id, platformSessionId, externalSessionId, signal)
    const candidates = projectTimeline(inspection.meta, inspection.events, false)
      .filter(item => sourceEventSeq(item) >= fromSeq)
      .map(item => ({ ...item, sessionId: platformSessionId }))
    const items = candidates.slice(0, eventLimit)
    const snapshots = await this.ctx.sessionPersistence.listSnapshots(signal)
    const revision = snapshots.find(item => item.header.id === id)?.revision
    const lastSourceSeq = items.length === 0 ? fromSeq - 1 : Math.max(...items.map(sourceEventSeq))
    const complete = items.length === candidates.length
    return {
      sessionId: platformSessionId,
      externalSessionId,
      runtime: RUNTIME_ID,
      items,
      complete,
      watermark: {
        nextSeq: complete
          ? Math.max(fromSeq, inspection.events.length)
          : Math.max(fromSeq, lastSourceSeq + 1),
        ...(revision === undefined ? {} : { revision: String(revision) }),
      },
    }
  }

  async state(
    platformSessionId: string,
    externalSessionId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    await this.ensureBinding(platformSessionId, externalSessionId, signal)
    const controller = await this.coldController(platformSessionId, externalSessionId, signal)
    const state = controller.state()
    if (state === undefined) throw new Error('bound Session has no projected state')
    return state as unknown as Record<string, unknown>
  }

  async notices(platformSessionId: string, externalSessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.ensureBinding(platformSessionId, externalSessionId, signal)
    return {
      sessionId: platformSessionId,
      externalSessionId,
      runtime: RUNTIME_ID,
      notices: this.interactions?.notices(platformSessionId) ?? [],
    }
  }

  async capabilities(
    platformSessionId: string,
    externalSessionId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    await this.ensureBinding(platformSessionId, externalSessionId, signal)
    const controller = await this.coldController(platformSessionId, externalSessionId, signal)
    const state = controller.state()
    if (state === undefined) throw new Error('bound Session has no projected state')
    return {
      sessionId: platformSessionId,
      externalSessionId,
      runtime: RUNTIME_ID,
      revision: state.revision,
      capabilities: sessionCapabilities(platformSessionId, state.status, await this.modelAvailable(controller, signal)),
    }
  }

  async createAndStart(
    operation: MessageOperation & { cwd: string; attachments: unknown[] },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (operation.attachments.length > 0) {
      throw new BridgeError('UNSUPPORTED_OPERATION', 'Attachments are not supported by Bridge protocol 1.0.', {
        retryable: false,
      })
    }
    const cwd = await validateWorkspace(operation.cwd)
    const reservation = await this.metadata.reserveCreation(operation.sessionId, operation.clientMessageId)
    const externalSessionId = reservation.externalSessionId
    const known = this.metadata.bindingForPlatform(operation.sessionId)
    if (known !== undefined && known.externalSessionId !== externalSessionId) {
      throw bindingConflict(operation.sessionId, externalSessionId)
    }
    const snapshots = await this.ctx.sessionPersistence.listSnapshots(signal)
    const existingSnapshot = snapshots.find(item => String(item.header.id) === externalSessionId)
    if (reservation.committed && existingSnapshot === undefined) {
      throw new BridgeError('PERSISTENCE_ERROR', 'A committed creation reservation has no DSH Session.', {
        retryable: false,
        sessionId: operation.sessionId,
        externalSessionId,
      })
    }
    const model = await this.requestedModel(operation.selections, signal)
    const permission = await this.requestedPermission(operation.selections)
    let controller = this.controllers.get(SessionId(externalSessionId))
    if (controller === undefined) {
      controller = new SessionController(
        SessionId(externalSessionId),
        operation.sessionId,
        model,
        permissionSelectionId(permission),
        item => this.onControllerState(item),
      )
      controller.lastObservedRevision = existingSnapshot?.revision
      this.controllers.set(controller.externalSessionId, controller)
    } else if (controller.platformSessionId === undefined) {
      controller.platformSessionId = operation.sessionId
    }
    return await controller.enqueue(async () => {
      try {
        if (controller.agent === undefined) {
          if (existingSnapshot === undefined) {
            const handle = await this.ctx.agents.create({
              sessionId: controller.externalSessionId,
              meta: { cwd },
              agentOptions: { provider: model.provider, model: model.model },
              ...(signal === undefined ? {} : { signal }),
              setup: agentCtx => { installModelSelection(agentCtx, controller.selection) },
            })
            controller.attach(handle)
          } else {
            await this.resume(controller, signal)
          }
        }
        const agent = controller.requireLive(id => this.ctx.agents.get(id))
        if (this.ctx.permissionPresets.current(agent.session.events) !== permission) {
          this.ctx.permissionPresets.set(agent.session, permission)
          await controller.updatePermission(permissionSelectionId(permission))
        }
        await this.metadata.bind(operation.sessionId, externalSessionId)
        const submission = await this.submitMessage(
          controller,
          'create',
          operation.content,
          operation.clientMessageId,
          { content: operation.content, cwd, selections: operation.selections ?? {} },
          'followup',
        )
        await this.metadata.commitCreation(reservation)
        const snapshot = (await this.ctx.sessionPersistence.listSnapshots(signal))
          .find(item => item.header.id === controller.externalSessionId)
        if (snapshot !== undefined) await this.safeEmit('session.meta.upsert', await this.metaFor(snapshot, signal))
        return receipt(operation.sessionId, externalSessionId, operation.clientMessageId, submission.duplicate)
      } catch (error: unknown) {
        await controller.transition('error', {
          code: 'CREATE_FAILED',
          message: 'DSH Session creation did not complete.',
        }).catch(() => undefined)
        throw error
      }
    })
  }

  async startTurn(
    operation: MessageOperation & { externalSessionId: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = await this.writableController(operation.sessionId, operation.externalSessionId, signal)
    return await controller.enqueue(async () => {
      await this.checkRevision(controller, signal)
      await this.resume(controller, signal)
      const submission = await this.submitMessage(
        controller,
        'start',
        operation.content,
        operation.clientMessageId,
        { content: operation.content, selections: operation.selections ?? {} },
        'followup',
        async () => {
          const agent = controller.requireLive(id => this.ctx.agents.get(id))
          if (agent.status !== 'idle' || controller.status !== 'idle') throw sessionConflict(controller, 'start a turn')
          await this.applySelections(controller, operation.selections, signal)
          if (!await this.modelAvailable(controller, signal)) {
            throw new BridgeError('INVALID_SELECTION', 'Select an available model before starting a turn.', {
              retryable: false,
              sessionId: operation.sessionId,
              externalSessionId: operation.externalSessionId,
            })
          }
          await controller.transition('pending')
        },
      )
      if (submission.duplicate) {
        await controller.transition(controller.agent?.status === 'running' ? 'running' : 'idle')
      }
      return receipt(operation.sessionId, operation.externalSessionId, operation.clientMessageId, submission.duplicate)
    })
  }

  async steer(
    operation: MessageOperation & { externalSessionId: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = await this.writableController(operation.sessionId, operation.externalSessionId, signal)
    return await controller.enqueue(async () => {
      await this.checkRevision(controller, signal)
      await this.resume(controller, signal)
      const submission = await this.submitMessage(
        controller,
        'steer',
        operation.content,
        operation.clientMessageId,
        { content: operation.content },
        'steer',
        () => {
          const agent = controller.requireLive(id => this.ctx.agents.get(id))
          if (agent.status !== 'running' || controller.status !== 'running') throw sessionConflict(controller, 'steer')
          return Promise.resolve()
        },
      )
      return receipt(operation.sessionId, operation.externalSessionId, operation.clientMessageId, submission.duplicate)
    })
  }

  async interrupt(platformSessionId: string, externalSessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const controller = await this.writableController(platformSessionId, externalSessionId, signal)
    return await controller.enqueue(async () => {
      const agent = controller.agent
      if (agent === undefined || agent.status === 'idle') {
        await controller.transition('idle')
        return { ok: true, duplicate: true }
      }
      await controller.transition('stopping')
      await this.interactions?.cancelFor(controller)
      agent.cancel({ kind: 'user' }, { keepInbox: false })
      await agent.whenIdle()
      await this.ctx.sessions.flush(agent.session)
      await this.observeRevision(controller, signal)
      await controller.transition('idle')
      return { ok: true, duplicate: false }
    })
  }

  async updateSelections(
    platformSessionId: string,
    externalSessionId: string,
    selections: RequestedSelections,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = await this.writableController(platformSessionId, externalSessionId, signal)
    return await controller.enqueue(async () => {
      await this.checkRevision(controller, signal)
      const agent = await this.resume(controller, signal)
      if (agent.status !== 'idle' || controller.status !== 'idle') throw sessionConflict(controller, 'update selections')
      await this.applySelections(controller, selections, signal)
      await this.ctx.sessions.flush(agent.session)
      await this.observeRevision(controller, signal)
      return { ok: true, selections: controller.state()?.selections }
    })
  }

  async listCommands(
    platformSessionId: string,
    externalSessionId: string,
    query: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = await this.writableController(platformSessionId, externalSessionId, signal)
    return await controller.enqueue(async () => {
      const agent = await this.resume(controller, signal)
      if (agent.status !== 'idle') throw sessionConflict(controller, 'list commands')
      const normalized = query?.toLocaleLowerCase()
      const commands = this.ctx.commands.list(agent)
        .filter(item => normalized === undefined
          || item.name.toLocaleLowerCase().includes(normalized)
          || item.description.toLocaleLowerCase().includes(normalized))
        .slice(0, limit)
        .map(item => ({
          name: item.name,
          description: item.description,
          acceptsArgs: item.input !== undefined,
          acceptsAttachments: item.input?.images === true,
          ...(item.input === undefined ? {} : { inputHint: item.input.hint }),
        }))
      return { commands }
    })
  }

  async executeCommand(
    platformSessionId: string,
    externalSessionId: string,
    command: string,
    raw: string | undefined,
    args: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = await this.writableController(platformSessionId, externalSessionId, signal)
    return await controller.enqueue(async () => {
      await this.checkRevision(controller, signal)
      const agent = await this.resume(controller, signal)
      if (agent.status !== 'idle' || controller.status !== 'idle') throw sessionConflict(controller, 'execute a command')
      const line = raw ?? `/${command}${args.length === 0 ? '' : ` ${args}`}`
      const result = await this.ctx.commands.execute(agent, line, [], signal)
      if (result === undefined) {
        throw new BridgeError('UNSUPPORTED_OPERATION', 'The command is not registered for this Session.', {
          retryable: false,
          sessionId: platformSessionId,
          externalSessionId,
          details: { code: 'COMMAND_NOT_FOUND' },
        })
      }
      await this.ctx.sessions.flush(agent.session)
      await this.observeRevision(controller, signal)
      return { ok: result.result.kind === 'success', commandId: String(result.commandId), result: result.result }
    })
  }

  async respondInteraction(
    platformSessionId: string,
    externalSessionId: string,
    noticeId: string,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = await this.writableController(platformSessionId, externalSessionId, signal)
    return await controller.enqueue(async () => {
      if (this.interactions === undefined) {
        throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'Approval integration is unavailable.', { retryable: true })
      }
      return await this.interactions.respond(platformSessionId, noticeId, actionId)
    })
  }

  async shutdown(): Promise<{ disposedSessions: number; failedSessions: number }> {
    let disposedSessions = 0
    let failedSessions = 0
    await Promise.all([...this.controllers.values()].map(controller => controller.enqueue(async () => {
      try {
        const handle = controller.handle
        if (handle !== undefined) {
          if (handle.agent.status === 'running') {
            handle.agent.cancel({ kind: 'disposed' }, { keepInbox: false })
            await handle.agent.whenIdle()
          }
          await this.ctx.sessions.flush(handle.agent.session)
          disposedSessions += 1
        }
        await controller.dispose()
      } catch (error: unknown) {
        failedSessions += 1
        this.ctx.logger.warn(`Agents Anywhere Bridge Session teardown failed: ${errorName(error)}`)
      }
    })))
    return { disposedSessions, failedSessions }
  }

  private async writableController(
    platformSessionId: string,
    externalSessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionController> {
    await this.ensureBinding(platformSessionId, externalSessionId, signal)
    return await this.coldController(platformSessionId, externalSessionId, signal)
  }

  private async coldController(
    platformSessionId: string | undefined,
    externalSessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionController> {
    const id = SessionId(externalSessionId)
    const known = this.controllers.get(id)
    if (known !== undefined) {
      if (known.platformSessionId === undefined) known.platformSessionId = platformSessionId
      return known
    }
    const inspection = await this.inspect(id, platformSessionId, externalSessionId, signal)
    const selection = await this.selectionFromEvents(inspection.events, signal)
    const permission = this.catalogs.permissionFor(inspection.events)
    const controller = new SessionController(id, platformSessionId, selection, permission, item => this.onControllerState(item))
    controller.lastObservedRevision = await this.revisionOf(id, signal)
    this.controllers.set(id, controller)
    const live = this.ctx.agents.get(id)
    if (live !== undefined) {
      controller.attachBorrowed(live)
      await controller.transition(live.status)
    }
    return controller
  }

  private async resume(controller: SessionController, signal?: AbortSignal): Promise<Agent> {
    const retained = controller.agent
    const live = this.ctx.agents.get(controller.externalSessionId)
    if (retained !== undefined && retained === live) return retained
    if (retained !== undefined) controller.detachStale()
    if (live !== undefined) {
      controller.attachBorrowed(live)
      controller.lastObservedRevision = await this.revisionOf(controller.externalSessionId, signal)
      controller.localAppendsSinceRevision = 0
      await controller.transition(live.status)
      return live
    }
    const selection = controller.selection.current
    if (selection === undefined) throw new Error('Session controller has no model selection')
    const handle = await this.ctx.agents.resume({
      resumeSessionId: controller.externalSessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      ...(signal === undefined ? {} : { signal }),
      setup: agentCtx => { installModelSelection(agentCtx, controller.selection) },
    })
    controller.attach(handle)
    controller.lastObservedRevision = await this.revisionOf(controller.externalSessionId, signal)
    controller.localAppendsSinceRevision = 0
    await controller.transition(handle.agent.status)
    return handle.agent
  }

  private async submitMessage(
    controller: SessionController,
    operation: 'create' | 'start' | 'steer',
    text: string,
    clientMessageId: string,
    idempotencyPayload: unknown,
    mode: 'followup' | 'steer',
    beforeSend: () => Promise<void> = () => Promise.resolve(),
  ): Promise<{ duplicate: boolean }> {
    const platformSessionId = controller.platformSessionId
    if (platformSessionId === undefined) throw new Error('cannot submit before binding a platform Session')
    const agent = controller.requireLive(id => this.ctx.agents.get(id))
    const expectedMessageId = deterministicMessageId(platformSessionId, clientMessageId)
    const logged = findMessage(agent.session.events, expectedMessageId)
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .find(message => String(message.id) === expectedMessageId)
    if ((logged !== undefined && !sameHumanMessage(logged.data, text))
      || (pending !== undefined && !sameHumanMessage(pending, text))) {
      throw idempotencyConflict(controller, 'The deterministic DSH MessageId contains different content.')
    }
    const stored = await this.metadata.recordMessage({
      platformSessionId,
      clientMessageId,
      operation,
      contentHash: sha256Hex(canonicalJson(idempotencyPayload)),
    })
    const alreadyAccepted = logged !== undefined || pending !== undefined
    if (!alreadyAccepted) {
      await beforeSend()
      const message = freezeMessage({
        id: MessageId(stored.record.messageId),
        role: 'user' as const,
        content: [{ type: 'text' as const, text }],
        source: { kind: 'user' as const },
      })
      if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
    }
    await this.ctx.sessions.flush(agent.session)
    await this.observeRevision(controller)
    return { duplicate: stored.duplicate || alreadyAccepted }
  }

  private async applySelections(
    controller: SessionController,
    selections: RequestedSelections | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (selections === undefined) return
    const model = selections.model === undefined ? undefined : await this.catalogs.resolveModel(selections.model, signal)
    const permission = selections.permission === undefined ? undefined : await this.catalogs.resolvePermission(selections.permission)
    const agent = controller.requireLive(id => this.ctx.agents.get(id))
    if (model !== undefined && controller.handle === undefined) {
      throw new BridgeError('UNSUPPORTED_OPERATION', 'Model selection cannot replace another Host consumer\'s live Agent routing.', {
        retryable: true,
        ...(controller.platformSessionId === undefined ? {} : { sessionId: controller.platformSessionId }),
        externalSessionId: String(controller.externalSessionId),
        details: { code: 'BORROWED_AGENT_MODEL_SELECTION' },
      })
    }
    if (permission !== undefined) {
      this.ctx.permissionPresets.set(agent.session, permission)
      await controller.updatePermission(permissionSelectionId(permission))
    }
    if (model !== undefined) await controller.updateModel(model)
  }

  private async requestedModel(selections: RequestedSelections | undefined, signal?: AbortSignal): Promise<ModelSelection> {
    return selections?.model === undefined
      ? await this.catalogs.defaultModel(signal)
      : await this.catalogs.resolveModel(selections.model, signal)
  }

  private async requestedPermission(selections: RequestedSelections | undefined): Promise<string> {
    return selections?.permission === undefined
      ? this.ctx.permissionPresets.defaultPreset
      : await this.catalogs.resolvePermission(selections.permission)
  }

  private async selectionFromEvents(events: readonly SessionEvent[], signal?: AbortSignal): Promise<ModelSelection> {
    const header = events.findLast(event => event.type === 'request/header')
    if (header === undefined) return await this.catalogs.defaultModel(signal)
    const config = header.data.header.config
    return {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    }
  }

  private async ensureBinding(
    platformSessionId: string,
    externalSessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const byPlatform = this.metadata.bindingForPlatform(platformSessionId)
    const byExternal = this.metadata.bindingForExternal(externalSessionId)
    if ((byPlatform !== undefined && byPlatform.externalSessionId !== externalSessionId)
      || (byExternal !== undefined && byExternal.platformSessionId !== platformSessionId)) {
      throw bindingConflict(platformSessionId, externalSessionId)
    }
    const exists = (await this.ctx.sessionPersistence.listSnapshots(signal))
      .some(item => String(item.header.id) === externalSessionId)
    if (!exists) {
      throw new BridgeError('SESSION_NOT_FOUND', 'The DSH Session does not exist.', {
        retryable: false,
        sessionId: platformSessionId,
        externalSessionId,
      })
    }
    if (byPlatform === undefined) await this.metadata.bind(platformSessionId, externalSessionId)
  }

  private async inspect(
    id: SessionId,
    platformSessionId: string | undefined,
    externalSessionId: string,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<Context['sessionPersistence']['inspect']>>> {
    try {
      return await this.ctx.sessionPersistence.inspect(id, signal)
    } catch (error: unknown) {
      throw new BridgeError('PERSISTENCE_ERROR', 'The DSH Session could not be inspected.', {
        retryable: true,
        ...(platformSessionId === undefined ? {} : { sessionId: platformSessionId }),
        externalSessionId,
      }, { cause: error })
    }
  }

  private async metaFor(snapshot: SessionPersistenceSnapshot, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const inspection = await this.inspect(snapshot.header.id, undefined, String(snapshot.header.id), signal)
    return this.metaFrom(snapshot.header, inspection.events, String(snapshot.revision))
  }

  private metaFrom(header: SessionHeader, events: readonly SessionEvent[], revision: string): Record<string, unknown> {
    const externalSessionId = String(header.id)
    const title = foldSessionTitle(events)?.title ?? null
    return {
      sessionId: this.metadata.bindingForExternal(externalSessionId)?.platformSessionId ?? null,
      externalSessionId,
      runtime: RUNTIME_ID,
      title,
      cwd: header.cwd ?? null,
      orderingTime: new Date(events.at(-1)?.time ?? header.createdAt).toISOString(),
      revision,
      requiresTimelineSync: true,
      metadata: {
        origin: header.origin ?? null,
        parentSessionId: header.parentSession === undefined ? null : String(header.parentSession),
      },
    }
  }

  private async publishEvent(
    controller: SessionController,
    header: SessionHeader,
    events: readonly SessionEvent[],
    event: SessionEvent,
  ): Promise<void> {
    const platformSessionId = controller.platformSessionId
    if (platformSessionId === undefined) return
    if (event.type === 'session/title') {
      await this.safeEmit('session.meta.upsert', this.metaFrom(header, events, `live:${events.length}`))
    }
    const candidates = projectTimeline(header, events, true)
      .filter(item => sourceEventSeq(item) === event.seq)
    for (const candidate of candidates) {
      await this.safeEmit('timeline.item.upsert', {
        sessionId: platformSessionId,
        externalSessionId: String(controller.externalSessionId),
        runtime: RUNTIME_ID,
        item: { ...candidate, sessionId: platformSessionId },
      })
    }
  }

  private async onControllerState(controller: SessionController): Promise<void> {
    const state = controller.state()
    if (state === undefined) return
    await this.safeEmit('session.state.update', state as unknown as Record<string, unknown>)
    await this.safeEmit('session.capabilities.update', {
      sessionId: state.sessionId,
      externalSessionId: state.externalSessionId,
      runtime: RUNTIME_ID,
      revision: state.revision,
      capabilities: sessionCapabilities(state.sessionId, state.status, await this.modelAvailable(controller)),
    })
  }

  private async safeEmit(method: OutboundNotificationMethod, params: Record<string, unknown>): Promise<void> {
    try {
      await this.emit(method, params)
    } catch (error: unknown) {
      this.logNotificationFailure(error)
    }
  }

  private logNotificationFailure(error: unknown): void {
    this.ctx.logger.warn(`Agents Anywhere Bridge notification failed: ${errorName(error)}`)
  }

  private async modelAvailable(controller: SessionController, signal?: AbortSignal): Promise<boolean> {
    const selection = controller.selection.current
    if (selection === undefined) return false
    try {
      await this.catalogs.resolveModel(modelSelectionId(selection), signal)
      return true
    } catch {
      return false
    }
  }

  private async checkRevision(controller: SessionController, signal?: AbortSignal): Promise<void> {
    const agent = controller.agent
    if (agent === undefined || controller.lastObservedRevision === undefined) return
    await this.ctx.sessions.flush(agent.session)
    const observed = await this.revisionOf(controller.externalSessionId, signal)
    if (observed !== undefined && observed !== controller.lastObservedRevision
      && controller.localAppendsSinceRevision === 0) {
      agent.cancel({ kind: 'disposed' }, { keepInbox: false })
      await agent.whenIdle().catch(() => undefined)
      if (controller.handle !== undefined) await controller.dispose().catch(() => undefined)
      else controller.detachStale()
      controller.lastObservedRevision = observed
      await controller.transition('error', {
        code: 'DSH_CONCURRENT_WRITER_DETECTED',
        message: 'The persisted DSH Session changed outside this Host process.',
      })
      throw new BridgeError('SESSION_CONFLICT', 'A concurrent DSH Session writer was detected.', {
        retryable: false,
        ...(controller.platformSessionId === undefined ? {} : { sessionId: controller.platformSessionId }),
        externalSessionId: String(controller.externalSessionId),
        details: { code: 'DSH_CONCURRENT_WRITER_DETECTED' },
      })
    }
    controller.lastObservedRevision = observed
    controller.localAppendsSinceRevision = 0
  }

  private async observeRevision(controller: SessionController, signal?: AbortSignal): Promise<void> {
    controller.lastObservedRevision = await this.revisionOf(controller.externalSessionId, signal)
    controller.localAppendsSinceRevision = 0
  }

  private async revisionOf(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    return (await this.ctx.sessionPersistence.listSnapshots(signal)).find(item => item.header.id === id)?.revision
  }

  private encodeCursor(value: CursorValue): string {
    const body = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    const signature = createHmac('sha256', this.cursorKey).update(body).digest('base64url')
    return `${body}.${signature}`
  }

  private decodeCursor(cursor: string): CursorValue {
    const [body, signature, extra] = cursor.split('.')
    if (body === undefined || signature === undefined || extra !== undefined) throw invalidCursor()
    const expected = createHmac('sha256', this.cursorKey).update(body).digest('base64url')
    const receivedBytes = Buffer.from(signature)
    const expectedBytes = Buffer.from(expected)
    if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) throw invalidCursor()
    try {
      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorValue
      if (typeof value.fingerprint !== 'string' || typeof value.orderingTime !== 'string'
        || typeof value.externalSessionId !== 'string') throw invalidCursor()
      return value
    } catch (error: unknown) {
      if (error instanceof BridgeError) throw error
      throw invalidCursor()
    }
  }
}

interface CursorValue {
  fingerprint: string
  orderingTime: string
  externalSessionId: string
}

async function validateWorkspace(value: string): Promise<string> {
  if (!isAbsolute(value)) {
    throw new BridgeError('INVALID_PARAMS', 'cwd must be an absolute path.', { retryable: false })
  }
  try {
    const resolved = await realpath(value)
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory')
    return resolved
  } catch (error: unknown) {
    if (error instanceof BridgeError) throw error
    throw new BridgeError('INVALID_PARAMS', 'cwd must identify an accessible directory.', {
      retryable: false,
    }, { cause: error })
  }
}

function findMessage(
  events: readonly SessionEvent[],
  messageId: string,
): Extract<SessionEvent, { type: 'user/message' }> | undefined {
  return events.find((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message' && String(event.data.id) === messageId)
}

function sameHumanMessage(message: Agent['inbox']['nextTurn'][number], text: string): boolean {
  return message.source.kind === 'user'
    && message.content.length === 1
    && message.content[0]?.type === 'text'
    && message.content[0].text === text
}

function receipt(
  sessionId: string,
  externalSessionId: string,
  clientMessageId: string,
  duplicate: boolean,
): Record<string, unknown> {
  return {
    ok: true,
    result: { sessionId, externalSessionId, clientMessageId, accepted: true, duplicate },
  }
}

function sourceEventSeq(item: TimelineItem): number {
  const value = item.source.eventSeq
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : item.orderSeq
}

function invalidCursor(): BridgeError {
  return new BridgeError('INVALID_PARAMS', 'Session cursor is invalid.', { retryable: false })
}

function bindingConflict(platformSessionId: string, externalSessionId: string): BridgeError {
  return new BridgeError('SESSION_CONFLICT', 'The supplied platform and DSH Session IDs do not match.', {
    retryable: false,
    sessionId: platformSessionId,
    externalSessionId,
    details: { code: 'SESSION_BINDING_CONFLICT' },
  })
}

function sessionConflict(controller: SessionController, operation: string): BridgeError {
  return new BridgeError('SESSION_CONFLICT', `The Session cannot ${operation} in its current state.`, {
    retryable: true,
    ...(controller.platformSessionId === undefined ? {} : { sessionId: controller.platformSessionId }),
    externalSessionId: String(controller.externalSessionId),
  })
}

function idempotencyConflict(controller: SessionController, message: string): BridgeError {
  return new BridgeError('IDEMPOTENCY_CONFLICT', message, {
    retryable: false,
    ...(controller.platformSessionId === undefined ? {} : { sessionId: controller.platformSessionId }),
    externalSessionId: String(controller.externalSessionId),
  })
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
