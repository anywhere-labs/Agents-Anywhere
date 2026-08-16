import { createHash, randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BridgeState } from './state.js'
import { canonicalJson, decodeModelSelection, decodePermissionSelection, modelSelectionId, permissionSelectionId } from './identity.js'
import { projectTimeline } from './projection.js'
import { RpcFault, StdioTransport } from './transport.js'
import type { BridgeConfig, DshServices, Interaction, JsonObject, JsonRpcRequest } from './types.js'

const CAPABILITIES = [
  'session.send_message', 'session.steer', 'session.interrupt', 'session.commands',
  'session.interaction.approval', 'catalog.model', 'catalog.permission',
]

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as JsonObject
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new RpcFault('INVALID_PARAMS', `${name} must be a non-empty string`)
  return value
}

function textMessage(content: string, clientMessageId?: string): unknown {
  if (clientMessageId !== undefined) {
    return freezeMessage({
      id: MessageId(`aa-${createHash('sha256').update(clientMessageId).digest('hex')}`),
      role: 'user',
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    })
  }
  return createUserMessage({
    content: [{ type: 'text', text: content }],
    source: { kind: 'user' },
  })
}

export class AgentsAnywhereBridge {
  private readonly state: BridgeState
  private readonly transport: StdioTransport
  private initialized = false
  private draining = false
  private connectorId = ''
  private readonly handles = new Map<string, any>()
  private readonly modelRefs = new Map<string, any>()
  private readonly interactions = new Map<string, Interaction>()
  private readonly notices = new Map<string, JsonObject>()
  private disposeQuestionProvider?: () => void
  private disposeApproval?: () => void
  private disposeSessionEvents?: () => void
  private readonly notificationTimers = new Map<string, NodeJS.Timeout>()
  private readonly operationTails = new Map<string, Promise<void>>()
  private readonly observedRevisions = new Map<string, string>()
  private readonly ownedEventsPending = new Set<string>()

  constructor(private readonly ctx: DshServices, private readonly config: BridgeConfig) {
    this.state = new BridgeState(config.stateRoot)
    this.transport = new StdioTransport(config.maxFrameBytes, request => this.dispatch(request), () => { void this.shutdown(1) })
  }

  async start(): Promise<void> {
    if (typeof this.ctx.appExit !== 'function') throw new Error('DSH cmdline appExit service is required')
    await this.state.initialize()
    this.registerInteractions()
    this.transport.start()
  }

  async dispose(): Promise<void> {
    this.transport.stop()
    this.disposeQuestionProvider?.()
    this.disposeApproval?.()
    this.disposeSessionEvents?.()
    for (const timer of this.notificationTimers.values()) clearTimeout(timer)
    this.notificationTimers.clear()
    await this.drain()
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    if (request.method === 'initialize') return this.initialize(request.params ?? {})
    if (!this.initialized) throw new RpcFault('NOT_INITIALIZED', 'initialize must be the first request')
    if (this.draining && request.method !== 'shutdown' && request.method !== 'ping') throw new RpcFault('SHUTTING_DOWN', 'bridge is shutting down')
    const params = request.params ?? {}
    switch (request.method) {
      case 'ping': return { nonce: params.nonce ?? null, status: this.draining ? 'draining' : 'ready' }
      case 'shutdown': return this.shutdown(0, false)
      case 'runtime.getConfig': return { metadata: { profile: 'aa', storageMode: 'dsh-native', sameSessionWriterLimit: 1, crossProcessWriterExclusion: false } }
      case 'runtime.getCapabilities': return this.capabilities()
      case 'catalog.listModels': return this.models(params)
      case 'catalog.listPermissions': return this.permissions(params)
      case 'session.list': return this.listSessions(params)
      case 'session.getSnapshot': return this.snapshot(params)
      case 'session.getState': return this.sessionState(params)
      case 'session.getNotices': return this.sessionNotices(params)
      case 'session.getCapabilities': return this.capabilities(required(params.sessionId, 'sessionId'))
      case 'session.createAndStart': return this.createAndStart(params)
      case 'session.startTurn': return this.startTurn(params)
      case 'session.steer': return this.steer(params)
      case 'session.interrupt': return this.interrupt(params)
      case 'session.updateSelections': return this.updateSelections(params)
      case 'session.listCommands': return this.listCommands(params)
      case 'session.executeCommand': return this.executeCommand(params)
      case 'session.respondInteraction': return this.respondInteraction(params)
      default: throw new RpcFault('METHOD_NOT_FOUND', `unknown bridge method: ${request.method}`)
    }
  }

  private async initialize(params: JsonObject): Promise<JsonObject> {
    if (this.initialized) throw new RpcFault('ALREADY_INITIALIZED', 'bridge has already been initialized')
    const version = required(params.protocolVersion, 'protocolVersion')
    if (version.split('.')[0] !== '1') {
      setImmediate(() => { void this.shutdown(64) })
      throw new RpcFault('PROTOCOL_VERSION_MISMATCH', `unsupported protocol version ${version}`)
    }
    if (params.runtime !== 'dsh') throw new RpcFault('INVALID_PARAMS', 'runtime must be dsh')
    this.connectorId = required(params.connectorId, 'connectorId')
    this.initialized = true
    queueMicrotask(() => { void this.publishBaselines() })
    return {
      identity: { runtime: 'dsh', runtimeVersion: 'unknown', bridgeVersion: '0.1.0', protocolVersion: '1.0', displayName: 'DeepSeek Harness' },
      storage: { mode: 'dsh-native', sameSessionWriterLimit: 1, crossProcessWriterExclusion: false },
      features: { attachments: false, sessionDiscovery: true, timelineSuffixRead: true, approval: true, userQuestions: true },
    }
  }

  private capabilities(sessionId?: string): JsonObject {
    return {
      runtime: 'dsh', revision: 1, ...(sessionId === undefined ? {} : { sessionId }),
      capabilities: [
        ...CAPABILITIES.map(capabilityId => ({ capabilityId, supported: true, available: true, allowed: true, ...(sessionId === undefined ? { scope: 'runtime' } : { scope: 'session', sessionId }) })),
        { capabilityId: 'runtime.attachment', supported: false, available: false, allowed: false, unavailableReason: 'DSH bridge protocol 1.0 does not accept attachments', ...(sessionId === undefined ? { scope: 'runtime' } : { scope: 'session', sessionId }) },
      ],
      metadata: { connectorId: this.connectorId },
    }
  }

  private async models(params: JsonObject): Promise<JsonObject> {
    const query = typeof params.query === 'string' ? params.query.toLowerCase() : ''
    const limit = Number.isSafeInteger(params.limit) ? Math.max(1, Math.min(500, Number(params.limit))) : 100
    const allEntries: JsonObject[] = []
    for (const provider of this.ctx.llm.listProviders()) {
      for (const model of await this.ctx.llm.listModels(provider.id)) {
        const resolved = await this.ctx.llm.resolveModelInfo(provider.id, model.id)
        const title = `${provider.name}: ${model.name}`
        const efforts = resolved.reasoning?.efforts ?? []
        const enabled = resolved.inputModalities === undefined || resolved.inputModalities.includes('text')
        allEntries.push({
          id: `${provider.id}/${model.id}`, title, selectionId: modelSelectionId(provider.id, model.id),
          ...(model.description === undefined ? {} : { description: model.description }),
          reasoningItems: efforts.map((effort: any) => ({ id: effort.id, title: effort.name, selectionId: modelSelectionId(provider.id, model.id, effort.id), ...(effort.description === undefined ? {} : { description: effort.description }) })),
          enabled, ...(enabled ? {} : { disabledReason: 'model does not accept text input' }), metadata: { provider: provider.id, model: model.id },
        })
      }
    }
    const entries = allEntries.filter(entry => !query || `${entry.id} ${entry.title}`.toLowerCase().includes(query))
    return { runtime: 'dsh', revision: this.catalogRevision(allEntries), models: entries.slice(0, limit) }
  }

  private permissions(params: JsonObject): JsonObject {
    const query = typeof params.query === 'string' ? params.query.toLowerCase() : ''
    const limit = Number.isSafeInteger(params.limit) ? Math.max(1, Math.min(500, Number(params.limit))) : 100
    const allPermissions = [...this.ctx.permissionPresets.names]
      .map((name: string) => {
        const option = this.ctx.permissionPresets.optionOf(name)
        return { id: name, title: option.name ?? name, selectionId: permissionSelectionId(name), ...(option.description === undefined ? {} : { description: option.description }), enabled: true, metadata: {} }
      })
    const permissions = allPermissions
      .filter((permission: JsonObject) => !query || `${permission.id} ${permission.title}`.toLowerCase().includes(query))
      .slice(0, limit)
    return { runtime: 'dsh', revision: this.catalogRevision(allPermissions), permissions }
  }

  private async listSessions(params: JsonObject): Promise<JsonObject> {
    const limit = Number.isSafeInteger(params.limit) ? Math.max(1, Math.min(500, Number(params.limit))) : 100
    const snapshots = await this.ctx.sessionPersistence.listSnapshots()
    const sessions = await Promise.all(snapshots.map(async (snapshot: any) => this.meta(snapshot.header, snapshot.revision)))
    sessions.sort((left, right) => String(right.orderingTime).localeCompare(String(left.orderingTime)) || String(left.externalSessionId).localeCompare(String(right.externalSessionId)))
    const offset = this.decodeCursor(params.cursor)
    const page = sessions.slice(offset, offset + limit)
    return { sessions: page, ...(offset + limit < sessions.length ? { nextCursor: Buffer.from(JSON.stringify({ offset: offset + limit })).toString('base64url') } : {}) }
  }

  private async meta(header: any, revision?: string): Promise<JsonObject> {
    const externalSessionId = String(header.id)
    const binding = await this.state.binding(externalSessionId)
    return {
      ...(binding === undefined ? {} : { sessionId: binding.sessionId }), externalSessionId, runtime: 'dsh',
      ...(typeof header.title === 'string' ? { title: header.title } : {}),
      ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
      orderingTime: new Date(header.updatedAt ?? header.createdAt ?? 0).toISOString(),
      ...(revision === undefined ? {} : { revision }), metadata: {},
    }
  }

  private async snapshot(params: JsonObject): Promise<JsonObject> {
    const { sessionId, externalSessionId } = await this.ids(params, false)
    const inspection = await this.ctx.sessionPersistence.inspect(SessionId(externalSessionId))
    const items = projectTimeline(externalSessionId, sessionId, inspection.events)
    const limit = Number.isSafeInteger(params.limit) ? Number(params.limit) : undefined
    const selected = limit === undefined ? items : items.slice(-limit)
    const snapshots = await this.ctx.sessionPersistence.listSnapshots()
    const revision = snapshots.find((entry: any) => String(entry.header.id) === externalSessionId)?.revision
    return { sessionId, externalSessionId, runtime: 'dsh', items: selected, complete: limit === undefined || selected.length === items.length, metadata: { ...(revision === undefined ? {} : { revision }) } }
  }

  private async sessionState(params: JsonObject): Promise<JsonObject> {
    const { sessionId, externalSessionId } = await this.ids(params, false)
    const agent = this.ctx.agents.get(SessionId(externalSessionId))
    const preset = agent === undefined ? undefined : this.ctx.permissionPresets.current(agent.session.events)
    const ref = this.modelRefs.get(externalSessionId)
    return {
      sessionId, externalSessionId, runtime: 'dsh', status: agent === undefined ? 'idle' : this.liveStatus(agent.session.events),
      selections: {
        ...(ref?.current === undefined ? {} : { model: modelSelectionId(ref.current.provider, ref.current.model, ref.current.reasoning?.effort ?? null) }),
        ...(preset === undefined ? {} : { permission: permissionSelectionId(String(preset)) }),
      }, metadata: {},
    }
  }

  private async sessionNotices(params: JsonObject): Promise<JsonObject> {
    const { sessionId } = await this.ids(params, false)
    return { notices: [...this.notices.values()].filter(notice => notice.sessionId === sessionId) }
  }

  private async createAndStart(params: JsonObject): Promise<JsonObject> {
    const sessionId = required(params.sessionId, 'sessionId')
    return this.serial(`session:${sessionId}`, () => this.createAndStartSerial(params, sessionId))
  }

  private async createAndStartSerial(params: JsonObject, sessionId: string): Promise<JsonObject> {
    this.rejectAttachments(params)
    const externalSessionId = `session-aa-${createHash('sha256').update(`${this.connectorId}\0${sessionId}`).digest('hex').slice(0, 32)}`
    const selections = object(params.selections)
    await this.state.bind({ sessionId, externalSessionId })
    const persisted = (await this.ctx.sessionPersistence.listSnapshots()).some((snapshot: any) => String(snapshot.header.id) === externalSessionId)
    const handle = persisted
      ? await this.ensureAgent(externalSessionId, typeof params.cwd === 'string' ? params.cwd : process.cwd(), selections)
      : await this.createAgent(externalSessionId, typeof params.cwd === 'string' ? params.cwd : process.cwd(), selections)
    const duplicate = await this.enqueue(handle.agent, externalSessionId, params)
    this.notifySession(sessionId, externalSessionId)
    return { ok: true, result: { sessionId, externalSessionId, ...(typeof params.clientMessageId === 'string' ? { clientMessageId: params.clientMessageId } : {}), accepted: true, duplicate } }
  }

  private async startTurn(params: JsonObject): Promise<JsonObject> {
    this.rejectAttachments(params)
    const { sessionId, externalSessionId } = await this.ids(params, true)
    return this.serial(`session:${externalSessionId}`, async () => {
      if (this.handles.has(externalSessionId)) await this.assertNoConcurrentWriter(externalSessionId)
      const handle = await this.ensureAgent(externalSessionId, typeof params.cwd === 'string' ? params.cwd : process.cwd(), object(params.selections))
      const duplicate = await this.enqueue(handle.agent, externalSessionId, params)
      this.notifySession(sessionId, externalSessionId)
      return { ok: true, result: { sessionId, externalSessionId, accepted: true, duplicate } }
    })
  }

  private async steer(params: JsonObject): Promise<JsonObject> {
    this.rejectAttachments(params)
    const { sessionId, externalSessionId } = await this.ids(params, true)
    return this.serial(`session:${externalSessionId}`, async () => {
      await this.assertNoConcurrentWriter(externalSessionId)
      const agent = this.ctx.agents.get(SessionId(externalSessionId))
      if (agent === undefined || this.liveStatus(agent.session.events) !== 'running') throw new RpcFault('SESSION_NOT_RUNNING', 'session has no running DSH turn')
      const clientMessageId = typeof params.clientMessageId === 'string' ? params.clientMessageId : undefined
      if (clientMessageId !== undefined && await this.state.hasMessage(externalSessionId, clientMessageId)) return { ok: true, result: { accepted: true, duplicate: true } }
      agent.steer(textMessage(required(params.content, 'content'), clientMessageId === undefined ? undefined : `${externalSessionId}\0${clientMessageId}`))
      if (clientMessageId !== undefined) await this.state.rememberMessage(externalSessionId, clientMessageId)
      this.notifySession(sessionId, externalSessionId)
      return { ok: true, result: { accepted: true, duplicate: false } }
    })
  }

  private async interrupt(params: JsonObject): Promise<JsonObject> {
    const sessionId = required(params.sessionId, 'sessionId')
    let boundExternalSessionId: string | undefined
    if (typeof params.externalSessionId !== 'string') {
      for (const external of this.handles.keys()) {
        if ((await this.state.binding(external))?.sessionId === sessionId) {
          boundExternalSessionId = external
          break
        }
      }
    }
    const externalSessionId = typeof params.externalSessionId === 'string' ? params.externalSessionId : boundExternalSessionId
    if (externalSessionId === undefined) return { ok: true, result: { interrupted: false } }
    const agent = this.ctx.agents.get(SessionId(externalSessionId))
    if (agent !== undefined) await agent.cancel({ kind: 'user' }, { keepInbox: false })
    return { ok: true, result: { interrupted: agent !== undefined } }
  }

  private async updateSelections(params: JsonObject): Promise<JsonObject> {
    const { externalSessionId } = await this.ids(params, true)
    return this.serial(`session:${externalSessionId}`, async () => {
      await this.assertNoConcurrentWriter(externalSessionId)
      const agent = await this.ensureIdleAgent(externalSessionId)
      this.applySelections(externalSessionId, agent, object(params.selections))
      return { ok: true, result: { updated: true } }
    })
  }

  private async listCommands(params: JsonObject): Promise<JsonObject> {
    const { externalSessionId } = await this.ids(params, false)
    const agent = await this.ensureIdleAgent(externalSessionId)
    const query = typeof params.query === 'string' ? params.query.toLowerCase() : ''
    const limit = Number.isSafeInteger(params.limit) ? Number(params.limit) : 50
    const commands = this.ctx.commands.list(agent).filter((command: any) => !query || `${command.name} ${command.description ?? ''}`.toLowerCase().includes(query)).slice(0, limit).map((command: any) => ({ id: command.name, title: command.name, ...(command.description === undefined ? {} : { description: command.description }), aliases: command.aliases ?? [], acceptsArgs: true, enabled: true, metadata: {} }))
    return { commands }
  }

  private async executeCommand(params: JsonObject): Promise<JsonObject> {
    const { externalSessionId } = await this.ids(params, true)
    return this.serial(`session:${externalSessionId}`, async () => {
      await this.assertNoConcurrentWriter(externalSessionId)
      const agent = await this.ensureIdleAgent(externalSessionId)
      const command = required(params.command, 'command')
      const known = this.ctx.commands.list(agent).some((entry: any) => entry.name === command || entry.aliases?.includes(command))
      if (!known) throw new RpcFault('COMMAND_NOT_FOUND', 'DSH session command was not found')
      const raw = typeof params.raw === 'string' ? params.raw : [command, ...(Array.isArray(params.args) ? params.args.map(String) : [])].join(' ')
      const result = await this.ctx.commands.execute(agent, raw, new AbortController().signal)
      return { command, ok: true, result: object(result) }
    })
  }

  private async respondInteraction(params: JsonObject): Promise<JsonObject> {
    const noticeId = required(params.noticeId, 'noticeId')
    const pending = this.interactions.get(noticeId)
    if (pending === undefined) throw new RpcFault('INTERACTION_NOT_PENDING', 'interaction is not pending')
    const action = required(params.actionId, 'actionId')
    const interactionType = pending.notice.interactionType
    let value: unknown
    if (interactionType === 'approval') {
      if (action !== 'allow' && action !== 'deny') throw new RpcFault('INVALID_INTERACTION_RESPONSE', 'approval action is invalid')
      value = action === 'allow' ? 'allowed-once' : 'rejected'
    } else {
      if (action !== 'submit') throw new RpcFault('INVALID_INTERACTION_RESPONSE', 'question action is invalid')
      const input = object(params.inputData)
      if (!Array.isArray(input.answers)) throw new RpcFault('INVALID_INTERACTION_RESPONSE', 'question answers are required')
      value = input
    }
    this.interactions.delete(noticeId)
    this.notices.delete(noticeId)
    pending.resolve(value)
    return { ok: true, result: { noticeId, accepted: true } }
  }

  private async ensureIdleAgent(externalSessionId: string): Promise<any> {
    let agent = this.ctx.agents.get(SessionId(externalSessionId))
    if (agent === undefined) {
      const snapshots = await this.ctx.sessionPersistence.listSnapshots()
      const snapshot = snapshots.find((entry: any) => String(entry.header.id) === externalSessionId)
      if (snapshot === undefined) throw new RpcFault('SESSION_NOT_FOUND', 'DSH session was not found')
      agent = (await this.ensureAgent(externalSessionId, typeof snapshot.header.cwd === 'string' ? snapshot.header.cwd : process.cwd(), {})).agent
    }
    if (this.liveStatus(agent.session.events) === 'running') throw new RpcFault('SESSION_RUNNING', 'operation requires an idle DSH session')
    return agent
  }

  private async createAgent(externalSessionId: string, cwd: string, selections: JsonObject): Promise<any> {
    const defaultSelection = this.ctx.agentDefaultModel.currentSelection()
    const selected = typeof selections.model === 'string' ? decodeModelSelection(selections.model) : defaultSelection
    const ref: any = { current: { provider: selected.provider, model: selected.model, ...(selected.reasoning === null || selected.reasoning === undefined ? {} : { reasoning: { effort: selected.reasoning } }) }, assembled: undefined }
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(externalSessionId), meta: { cwd }, agentOptions: { provider: selected.provider, model: selected.model },
      setup: (agentCtx: any) => installModelSelection(agentCtx, ref),
    })
    this.handles.set(externalSessionId, handle)
    this.modelRefs.set(externalSessionId, ref)
    this.applySelections(externalSessionId, handle.agent, selections)
    await this.refreshObservedRevision(externalSessionId)
    return handle
  }

  private async ensureAgent(externalSessionId: string, cwd: string, selections: JsonObject): Promise<any> {
    const existing = this.handles.get(externalSessionId)
    if (existing !== undefined) return existing
    const defaultSelection = this.ctx.agentDefaultModel.currentSelection()
    const selected = typeof selections.model === 'string' ? decodeModelSelection(selections.model) : defaultSelection
    const ref: any = { current: { provider: selected.provider, model: selected.model }, assembled: undefined }
    const handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(externalSessionId), agentOptions: { provider: selected.provider, model: selected.model }, setup: (agentCtx: any) => installModelSelection(agentCtx, ref) })
    this.handles.set(externalSessionId, handle)
    this.modelRefs.set(externalSessionId, ref)
    this.applySelections(externalSessionId, handle.agent, selections)
    await this.refreshObservedRevision(externalSessionId)
    return handle
  }

  private async assertNoConcurrentWriter(externalSessionId: string): Promise<void> {
    const snapshots = await this.ctx.sessionPersistence.listSnapshots()
    const current = snapshots.find((entry: any) => String(entry.header.id) === externalSessionId)?.revision
    if (typeof current !== 'string') return
    const observed = this.observedRevisions.get(externalSessionId)
    if (this.ownedEventsPending.delete(externalSessionId) || observed === undefined) {
      this.observedRevisions.set(externalSessionId, current)
      return
    }
    if (observed !== current) {
      throw new RpcFault(
        'DSH_CONCURRENT_WRITER_DETECTED',
        'native DSH session revision changed outside the Agents Anywhere bridge',
      )
    }
  }

  private async refreshObservedRevision(externalSessionId: string): Promise<void> {
    const snapshots = await this.ctx.sessionPersistence.listSnapshots()
    const revision = snapshots.find((entry: any) => String(entry.header.id) === externalSessionId)?.revision
    if (typeof revision === 'string') this.observedRevisions.set(externalSessionId, revision)
    this.ownedEventsPending.delete(externalSessionId)
  }

  private applySelections(externalSessionId: string, agent: any, selections: JsonObject): void {
    if (typeof selections.model === 'string') {
      const selection = decodeModelSelection(selections.model)
      const ref = this.modelRefs.get(externalSessionId)
      if (ref !== undefined) ref.current = { provider: selection.provider, model: selection.model, ...(selection.reasoning === null ? {} : { reasoning: { effort: selection.reasoning } }) }
    }
    if (typeof selections.permission === 'string') this.ctx.permissionPresets.set(agent.session, decodePermissionSelection(selections.permission))
  }

  private async enqueue(agent: any, externalSessionId: string, params: JsonObject): Promise<boolean> {
    const clientMessageId = typeof params.clientMessageId === 'string' ? params.clientMessageId : undefined
    if (clientMessageId !== undefined && await this.state.hasMessage(externalSessionId, clientMessageId)) return true
    const message = textMessage(required(params.content, 'content'), clientMessageId === undefined ? undefined : `${externalSessionId}\0${clientMessageId}`) as { id?: string }
    if (message.id !== undefined && agent.session.events.some((event: any) => event.type === 'user/message' && event.data?.id === message.id)) {
      if (clientMessageId !== undefined) await this.state.rememberMessage(externalSessionId, clientMessageId)
      return true
    }
    agent.followup(message)
    await this.ctx.sessions.flush(agent.session)
    if (clientMessageId !== undefined) await this.state.rememberMessage(externalSessionId, clientMessageId)
    return false
  }

  private async ids(params: JsonObject, requireBinding: boolean): Promise<{ sessionId: string; externalSessionId: string }> {
    const externalSessionId = required(params.externalSessionId, 'externalSessionId')
    const binding = await this.state.binding(externalSessionId)
    const supplied = typeof params.sessionId === 'string' ? params.sessionId : undefined
    if (binding !== undefined && supplied !== undefined && binding.sessionId !== supplied) throw new RpcFault('SESSION_BINDING_CONFLICT', 'AA and DSH session binding does not match')
    if (requireBinding && binding === undefined) throw new RpcFault('SESSION_BINDING_CONFLICT', 'DSH session is not bound to an AA session')
    return { sessionId: binding?.sessionId ?? supplied ?? `unbound:${externalSessionId}`, externalSessionId }
  }

  private rejectAttachments(params: JsonObject): void {
    if (Array.isArray(params.attachments) && params.attachments.length > 0) throw new RpcFault('UNSUPPORTED_OPERATION', 'DSH bridge protocol 1.0 does not accept attachments')
  }

  private decodeCursor(value: unknown): number {
    if (value === undefined) return 0
    try {
      const parsed = JSON.parse(Buffer.from(required(value, 'cursor'), 'base64url').toString('utf8')) as { offset?: unknown }
      if (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error()
      return Number(parsed.offset)
    } catch { throw new RpcFault('INVALID_CURSOR', 'session cursor is invalid') }
  }

  private catalogRevision(value: unknown): number {
    return Number.parseInt(createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12), 16)
  }

  private async serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>(resolve => { release = resolve })
    const next = previous.then(() => tail)
    this.operationTails.set(key, next)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.operationTails.get(key) === next) this.operationTails.delete(key)
    }
  }

  private notifySession(sessionId: string, externalSessionId: string): void {
    queueMicrotask(() => {
      void (async () => {
        const snapshots = await this.ctx.sessionPersistence.listSnapshots()
        const entry = snapshots.find((candidate: any) => String(candidate.header.id) === externalSessionId)
        if (entry !== undefined) {
          this.observedRevisions.set(externalSessionId, entry.revision)
          this.ownedEventsPending.delete(externalSessionId)
          this.transport.notify('session.meta.upsert', { ...(await this.meta(entry.header, entry.revision)), sessionId })
        }
        const snapshot = await this.snapshot({ sessionId, externalSessionId })
        this.transport.notify('timeline.sync', snapshot)
        this.transport.notify('session.state.update', await this.sessionState({ sessionId, externalSessionId }))
      })().catch(error => this.ctx.logger.error(error))
    })
  }

  private registerInteractions(): void {
    if (typeof this.ctx.userQuestions?.registerProvider === 'function') {
      this.disposeQuestionProvider = this.ctx.userQuestions.registerProvider({ ask: (request: any) => this.question(request) })
    }
    if (typeof this.ctx.on === 'function') {
      this.disposeApproval = this.ctx.on('approval/request', (request: any, next: () => unknown) => {
        if (request.agent?.session?.id === undefined) return next()
        return this.approval(request)
      })
      this.disposeSessionEvents = this.ctx.on('session/event', (session: any) => {
        const externalSessionId = String(session.id)
        this.ownedEventsPending.add(externalSessionId)
        if (this.notificationTimers.has(externalSessionId)) return
        const timer = setTimeout(() => {
          this.notificationTimers.delete(externalSessionId)
          void this.state.binding(externalSessionId).then((binding) => {
            if (binding !== undefined) this.notifySession(binding.sessionId, externalSessionId)
          }).catch(error => this.ctx.logger.error(error))
        }, 25)
        this.notificationTimers.set(externalSessionId, timer)
      })
    }
  }

  private liveStatus(events: readonly any[]): string {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const type = events[index]?.type
      if (type === 'turn/end') return 'idle'
      if (type === 'turn/start') return 'running'
    }
    return 'idle'
  }

  private question(request: any): Promise<unknown> {
    const externalSessionId = String(request.agent?.session?.id ?? '')
    return this.interaction(externalSessionId, 'question', 'DSH needs more information', { questions: request.questions }, value => value, request.signal)
  }

  private approval(request: any): Promise<unknown> {
    const externalSessionId = String(request.agent.session.id)
    return this.interaction(externalSessionId, 'approval', `Approve ${request.toolName ?? 'tool'}?`, { toolName: request.toolName, callId: request.callId, reason: request.reason }, value => value, request.signal)
  }

  private async interaction(externalSessionId: string, interactionType: string, title: string, context: JsonObject, transform: (value: unknown) => unknown, signal?: AbortSignal): Promise<unknown> {
    const binding = await this.state.binding(externalSessionId)
    if (binding === undefined) return interactionType === 'approval' ? 'denied' : Promise.reject(new Error('unbound DSH session cannot request AA interaction'))
    return new Promise((resolve, reject) => {
      const noticeId = `dsh_notice_${randomUUID()}`
      const settle = (value: unknown): void => resolve(transform(value))
      const notice: JsonObject = {
        noticeId, sessionId: binding.sessionId, runtime: 'dsh', type: 'interaction', title, severity: 'warning', status: 'open', interactionType,
        responseRequired: true, actions: interactionType === 'approval' ? [{ id: 'allow', title: 'Allow' }, { id: 'deny', title: 'Deny' }] : [{ id: 'submit', title: 'Submit' }],
        source: { runtime: 'dsh' }, context, metadata: {},
      }
      this.notices.set(noticeId, notice)
      this.interactions.set(noticeId, { notice, resolve: settle, reject })
      const abort = (): void => {
        if (!this.interactions.delete(noticeId)) return
        this.notices.delete(noticeId)
        if (interactionType === 'approval') resolve('cancelled'); else reject(new Error('DSH question was cancelled'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.transport.notify('notice.upsert', notice)
    })
  }

  private async publishBaselines(): Promise<void> {
    this.transport.notify('runtime.capabilities.update', this.capabilities())
    this.transport.notify('catalog.model.update', await this.models({ limit: 500 }))
    this.transport.notify('catalog.permission.update', this.permissions({ limit: 500 }))
  }

  private async shutdown(code: number, exit = true): Promise<JsonObject> {
    if (!this.draining) {
      this.draining = true
      if (exit) this.transport.stop()
      await this.drain()
    }
    if (exit) queueMicrotask(() => this.ctx.appExit?.(code))
    else setImmediate(() => {
      this.transport.stop()
      this.ctx.appExit?.(code)
    })
    return { ok: true, result: { drained: true } }
  }

  private async drain(): Promise<void> {
    for (const pending of this.interactions.values()) pending.reject(new Error('DSH bridge is shutting down'))
    this.interactions.clear()
    const jobs = [...this.handles.values()].map(async handle => {
      try { await handle.agent.cancel({ kind: 'user' }, { keepInbox: false }) } catch {}
      try { await this.ctx.sessions.flush(handle.agent.session) } catch {}
      try { await handle.dispose() } catch {}
    })
    await Promise.race([Promise.allSettled(jobs), new Promise(resolve => setTimeout(resolve, this.config.shutdownTimeoutMs))])
    this.handles.clear()
  }
}
