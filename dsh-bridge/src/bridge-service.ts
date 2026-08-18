import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-workspace'
import { MetadataStore } from './persistence/metadata.js'
import { CatalogManager } from './runtime/catalogs.js'
import { runtimeCapabilities } from './runtime/capabilities.js'
import { InteractionManager } from './runtime/interactions.js'
import { SessionManager, type RequestedSelections } from './runtime/sessions.js'
import { BridgeError } from './wire/errors.js'
import {
  PROTOCOL_VERSION,
  RUNTIME_ID,
} from './wire/protocol.js'
import { LoopbackJsonRpcServer, type LoopbackServerHandler } from './wire/server.js'
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest } from './wire/types.js'
import {
  arrayField,
  isRecord,
  limitField,
  objectField,
  optionalBooleanField,
  optionalStringField,
  stringField,
} from './wire/validation.js'

const MAX_FRAME_BYTES = 32 * 1024 * 1024
const BRIDGE_VERSION = '0.1.0'
const RUNTIME_CAPABILITIES_REVISION = 1
const DSH_RUNTIME_VERSION = (createRequire(import.meta.url)('@deepseek-ai/dsh-agent/package.json') as { version: string }).version

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentsAnywhereBridge: AgentsAnywhereBridgeService
  }
}

/** Deployment-tunable bridge settings. */
export interface Config {
  stateRoot?: string
  maxFrameBytes?: number
  readRequestTimeoutMs?: number
  writeRequestTimeoutMs?: number
  shutdownTimeoutMs?: number
  maxListLimit?: number
  maxCommandLimit?: number
  maxPendingInteractions?: number
}

interface ResolvedConfig {
  stateRoot: string
  maxFrameBytes: number
  readRequestTimeoutMs: number
  writeRequestTimeoutMs: number
  shutdownTimeoutMs: number
  maxListLimit: number
  maxCommandLimit: number
  maxPendingInteractions: number
}

/** Agents Anywhere SDK service hosted by the DSH Desktop process. */
export class AgentsAnywhereBridgeService extends Service implements LoopbackServerHandler {
  static Config: z<Config> = z.object({
    stateRoot: z.string().required(),
    maxFrameBytes: z.natural().min(1).max(MAX_FRAME_BYTES).default(8 * 1024 * 1024),
    readRequestTimeoutMs: z.natural().min(1).default(30_000),
    writeRequestTimeoutMs: z.natural().min(1).default(60_000),
    shutdownTimeoutMs: z.natural().min(1).default(15_000),
    maxListLimit: z.natural().min(1).default(500),
    maxCommandLimit: z.natural().min(1).default(200),
    maxPendingInteractions: z.natural().min(1).default(64),
  })

  static inject = [
    'agents',
    'sessions',
    'sessionPersistence',
    'attachments',
    'llm',
    'agentDefaultModel',
    'commands',
    'permissionPresets',
    'sessionTitle',
    'approval',
    'userQuestions',
    'workspaceRegistry',
  ]

  private readonly config: ResolvedConfig
  private readonly metadata: MetadataStore
  private readonly activeRequests = new Map<string, AbortController>()
  private endpoint: LoopbackJsonRpcServer | undefined
  private catalogs: CatalogManager | undefined
  private sessions: SessionManager | undefined
  private interactions: InteractionManager | undefined
  private initialized = false
  private connectorId: string | undefined
  private shuttingDown = false
  private shutdownPromise: Promise<Record<string, unknown>> | undefined
  private disposeRegistrations: (() => void) | undefined

  /**
   * Construct the service without claiming process streams.
   * @param ctx - Fully composed DSH base context.
   * @param config - Schema-validated plugin configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentsAnywhereBridge')
    if (config.stateRoot === undefined || !isAbsolute(config.stateRoot)) {
      throw new Error('agents-anywhere bridge stateRoot must be an absolute path')
    }
    this.config = {
      stateRoot: resolve(config.stateRoot),
      maxFrameBytes: config.maxFrameBytes ?? 8 * 1024 * 1024,
      readRequestTimeoutMs: config.readRequestTimeoutMs ?? 30_000,
      writeRequestTimeoutMs: config.writeRequestTimeoutMs ?? 60_000,
      shutdownTimeoutMs: config.shutdownTimeoutMs ?? 15_000,
      maxListLimit: config.maxListLimit ?? 500,
      maxCommandLimit: config.maxCommandLimit ?? 200,
      maxPendingInteractions: config.maxPendingInteractions ?? 64,
    }
    this.metadata = new MetadataStore(this.config.stateRoot)
  }

  /** Validate composition, register reversible resources, and start the loopback endpoint. */
  async [Service.init](): Promise<void> {
    await this.validateStateRoot()
    await this.metadata.initialize()
    await this.ctx.sessionPersistence.listSnapshots()
    const catalogs = new CatalogManager(this.ctx, this.metadata)
    await catalogs.refresh()
    this.catalogs = catalogs
    const sessions = new SessionManager(
      this.ctx,
      this.metadata,
      catalogs,
      this.config.maxListLimit,
      this.config.maxCommandLimit,
      (method, params) => this.notify(method, params),
      () => undefined,
      () => undefined,
    )
    const interactions = new InteractionManager(
      this.ctx,
      this.config.maxPendingInteractions,
      agent => sessions.controllerForAgent(agent),
      notice => this.notify('notice.upsert', notice as unknown as Record<string, unknown>),
      () => undefined,
    )
    sessions.setInteractions(interactions)
    this.sessions = sessions
    this.interactions = interactions
    const disposeObservers = sessions.registerObservers()
    const disposeInteractions = interactions.register()
    const disposeCatalog = this.ctx.on('llm/adapters-updated', async () => {
      const snapshot = await catalogs.refresh()
      await this.publishCatalogs(snapshot)
    })
    this.disposeRegistrations = once(() => {
      disposeCatalog()
      disposeObservers()
      disposeInteractions()
    })
    const endpoint = new LoopbackJsonRpcServer(this.config.stateRoot, this.config.maxFrameBytes, this)
    await endpoint.start()
    this.endpoint = endpoint
    this.ctx.effect(() => async () => {
      await this.shutdownCore('service-dispose')
    }, 'agentsAnywhereBridge.lifecycle()')
  }

  /** Dispatch one concurrent JSON-RPC request with duplicate-ID protection. */
  async request(frame: JsonRpcRequest): Promise<unknown> {
    const requestKey = `${typeof frame.id}:${String(frame.id)}`
    if (this.activeRequests.has(requestKey)) {
      throw new BridgeError('INVALID_REQUEST', 'A request with this id is already in flight.', { retryable: false })
    }
    if (!this.initialized && frame.method !== 'initialize') {
      throw new BridgeError('NOT_INITIALIZED', 'initialize must be the first request.', { retryable: false })
    }
    if (this.shuttingDown && frame.method !== 'ping') {
      throw new BridgeError('SHUTTING_DOWN', 'The bridge is shutting down.', { retryable: false })
    }
    const controller = new AbortController()
    this.activeRequests.set(requestKey, controller)
    const timeoutMs = isWriteMethod(frame.method)
      ? this.config.writeRequestTimeoutMs
      : this.config.readRequestTimeoutMs
    try {
      return await withTimeout(
        this.dispatch(
          frame.method,
          frame.params,
          controller.signal,
        ),
        timeoutMs,
        controller,
      )
    } finally {
      this.activeRequests.delete(requestKey)
    }
  }

  /** Handle supported Connector notifications. */
  async notification(frame: JsonRpcNotification): Promise<void> {
    if (frame.method !== '$/cancelRequest') return
    const id = frame.params.id
    if (!validRequestId(id)) throw new BridgeError('INVALID_PARAMS', '$/cancelRequest requires a valid id.', { retryable: false })
    this.activeRequests.get(`${typeof id}:${String(id)}`)?.abort(new Error('request cancelled by Connector'))
  }

  /** Reset connection state after a Connector disconnect without stopping DSH Desktop. */
  async eof(): Promise<void> {
    await this.disconnected('connector-eof')
  }

  /** Log an unrecoverable connection failure without stopping DSH Desktop. */
  async fatal(error: BridgeError): Promise<void> {
    this.ctx.logger.warn(`Agents Anywhere bridge connection failed: ${error.data.code}`)
  }

  /** Abort connection-scoped work and permit the next authenticated Connector. */
  async disconnected(reason: string): Promise<void> {
    for (const controller of this.activeRequests.values()) controller.abort(new Error(`bridge disconnected: ${reason}`))
    this.activeRequests.clear()
    this.initialized = false
    this.connectorId = undefined
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const sessions = this.requireSessions()
    const catalogs = this.requireCatalogs()
    switch (method) {
      case 'initialize':
        return await this.initialize(params)
      case 'runtime.getConfig':
        return {
          runtime: RUNTIME_ID,
          protocolVersion: PROTOCOL_VERSION,
          bridgeVersion: BRIDGE_VERSION,
          config: { ...this.config },
          metadata: {
            storageMode: 'dsh-native',
            sameSessionWriterLimit: 1,
            crossProcessWriterExclusion: false,
            profile: 'web',
          },
        }
      case 'runtime.getCapabilities':
        return runtimeCapabilitiesPayload()
      case 'catalog.listModels': {
        const snapshot = await catalogs.current()
        const query = optionalStringField(params, 'query')?.toLocaleLowerCase()
        const limit = limitField(params, 'limit', this.config.maxListLimit, this.config.maxListLimit)
        const models = snapshot.models.filter(item => query === undefined
            || item.name.toLocaleLowerCase().includes(query)
            || item.provider.toLocaleLowerCase().includes(query)
            || item.model.toLocaleLowerCase().includes(query)).slice(0, limit)
        return modelCatalogPayload(snapshot.revision, models)
      }
      case 'catalog.listPermissions': {
        const snapshot = await catalogs.current()
        const query = optionalStringField(params, 'query')?.toLocaleLowerCase()
        const limit = limitField(params, 'limit', this.config.maxListLimit, this.config.maxListLimit)
        const permissions = snapshot.permissions.filter(item => query === undefined
            || item.name.toLocaleLowerCase().includes(query)
            || item.preset.toLocaleLowerCase().includes(query)).slice(0, limit)
        return permissionCatalogPayload(snapshot.revision, permissions)
      }
      case 'session.list':
        return await sessions.listSessions(
          limitField(params, 'limit', Math.min(100, this.config.maxListLimit), this.config.maxListLimit),
          optionalStringField(params, 'cursor'),
          optionalBooleanField(params, 'force') ?? false,
          signal,
        )
      case 'session.getSnapshot': {
        const pair = sessionPair(params)
        return await sessions.snapshot(
          pair.sessionId,
          pair.externalSessionId,
          nonNegativeInteger(params, 'fromSeq', 0),
          limitField(params, 'limit', this.config.maxListLimit, this.config.maxListLimit),
          signal,
        )
      }
      case 'session.getState': {
        const pair = sessionPair(params)
        return await sessions.state(pair.sessionId, pair.externalSessionId, signal)
      }
      case 'session.getNotices': {
        const pair = sessionPair(params)
        return await sessions.notices(pair.sessionId, pair.externalSessionId)
      }
      case 'session.getCapabilities': {
        const pair = sessionPair(params)
        return await sessions.capabilities(pair.sessionId, pair.externalSessionId, signal)
      }
      case 'session.createAndStart': {
        const attachments = arrayField(params, 'attachments')
        const selections = selectionsField(params)
        return await sessions.createAndStart({
          sessionId: stringField(params, 'sessionId'),
          content: stringField(params, 'content'),
          clientMessageId: stringField(params, 'clientMessageId'),
          cwd: stringField(params, 'cwd'),
          attachments,
          ...(selections === undefined ? {} : { selections }),
        }, signal)
      }
      case 'session.startTurn': {
        const pair = sessionPair(params)
        const selections = selectionsField(params)
        return await sessions.startTurn({
          ...pair,
          content: stringField(params, 'content'),
          clientMessageId: stringField(params, 'clientMessageId'),
          ...(selections === undefined ? {} : { selections }),
        }, signal)
      }
      case 'session.steer': {
        const pair = sessionPair(params)
        return await sessions.steer({
          ...pair,
          content: stringField(params, 'content'),
          clientMessageId: stringField(params, 'clientMessageId'),
        }, signal)
      }
      case 'session.interrupt': {
        const pair = sessionPair(params)
        return await sessions.interrupt(pair.sessionId, pair.externalSessionId)
      }
      case 'session.updateSelections': {
        const pair = sessionPair(params)
        return await sessions.updateSelections(pair.sessionId, pair.externalSessionId, requiredSelections(params), signal)
      }
      case 'session.listCommands': {
        const pair = sessionPair(params)
        return await sessions.listCommands(
          pair.sessionId,
          pair.externalSessionId,
          optionalStringField(params, 'query'),
          limitField(params, 'limit', Math.min(100, this.config.maxCommandLimit), this.config.maxCommandLimit),
          signal,
        )
      }
      case 'session.executeCommand': {
        const pair = sessionPair(params)
        return await sessions.executeCommand(
          pair.sessionId,
          pair.externalSessionId,
          stringField(params, 'command'),
          optionalStringField(params, 'raw'),
          optionalStringField(params, 'args') ?? '',
          signal,
        )
      }
      case 'session.respondInteraction': {
        const pair = sessionPair(params)
        return await sessions.respondInteraction(
          pair.sessionId,
          pair.externalSessionId,
          stringField(params, 'noticeId'),
          stringField(params, 'actionId'),
          params.inputData,
          signal,
        )
      }
      case 'ping':
        return { nonce: params.nonce ?? null, initialized: this.initialized, shuttingDown: this.shuttingDown }
      default:
        throw new BridgeError('METHOD_NOT_FOUND', `Unknown bridge method: ${method}`, { retryable: false })
    }
  }

  private async initialize(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.initialized) throw new BridgeError('INVALID_REQUEST', 'initialize may be called only once.', { retryable: false })
    const protocolVersion = stringField(params, 'protocolVersion')
    if (!/^\d+\.\d+$/u.test(protocolVersion)) {
      throw new BridgeError('INVALID_PARAMS', 'protocolVersion must use major.minor notation.', { retryable: false })
    }
    if (protocolVersion.split('.')[0] !== PROTOCOL_VERSION.split('.')[0]) {
      throw new BridgeError('PROTOCOL_VERSION_MISMATCH', 'Bridge protocol major versions are incompatible.', { retryable: false })
    }
    if (stringField(params, 'runtime') !== RUNTIME_ID) {
      throw new BridgeError('UNSUPPORTED_OPERATION', 'This process exposes only the dsh Runtime.', { retryable: false })
    }
    const connectorId = stringField(params, 'connectorId')
    const clientInfo = objectField(params, 'clientInfo')
    stringField(clientInfo, 'name')
    stringField(clientInfo, 'version')
    this.connectorId = connectorId
    this.initialized = true
    const catalogs = await this.requireCatalogs().current()
    setImmediate(() => {
      void this.publishCatalogs(catalogs)
        .then(() => this.notify('runtime.capabilities.update', runtimeCapabilitiesPayload()))
    })
    return {
      identity: {
        runtime: RUNTIME_ID,
        runtimeVersion: DSH_RUNTIME_VERSION,
        bridgeVersion: BRIDGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        displayName: 'DeepSeek Harness',
      },
      storage: {
        mode: 'dsh-native',
        sameSessionWriterLimit: 1,
        crossProcessWriterExclusion: false,
      },
      features: {
        attachments: false,
        sessionDiscovery: true,
        timelineSuffixRead: true,
        approval: true,
        userQuestions: this.interactions?.supportsUserQuestions() ?? false,
      },
    }
  }

  private async publishCatalogs(snapshot: Awaited<ReturnType<CatalogManager['current']>>): Promise<void> {
    if (!this.initialized) return
    await this.notify('catalog.model.update', modelCatalogPayload(snapshot.revision, snapshot.models))
    await this.notify('catalog.permission.update', permissionCatalogPayload(snapshot.revision, snapshot.permissions))
  }

  private notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (!this.initialized) return Promise.resolve()
    const endpoint = this.endpoint
    if (endpoint === undefined) throw new Error('agents-anywhere bridge endpoint is not initialized')
    return endpoint.notify(method, params).catch((error: unknown) => {
      void this.disconnected('output-failed')
      throw error
    })
  }

  private shutdownCore(reason: string): Promise<Record<string, unknown>> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise
    this.shuttingDown = true
    for (const controller of this.activeRequests.values()) controller.abort(new Error(`bridge shutdown: ${reason}`))
    const operation = (async (): Promise<Record<string, unknown>> => {
      await this.interactions?.cancelAll()
      const result = await withDeadline(
        this.sessions?.shutdown() ?? Promise.resolve({ disposedSessions: 0, failedSessions: 0 }),
        this.config.shutdownTimeoutMs,
      ).catch(() => ({ disposedSessions: 0, failedSessions: 1 }))
      this.disposeRegistrations?.()
      this.disposeRegistrations = undefined
      await this.endpoint?.stop()
      this.endpoint = undefined
      return { ok: result.failedSessions === 0, reason, ...result }
    })()
    this.shutdownPromise = operation
    return operation
  }

  private async validateStateRoot(): Promise<void> {
    const location = this.ctx.sessionPersistence.locate({
      version: SESSION_FORMAT_VERSION,
      id: SessionId('aa-bridge-location-probe'),
      createdAt: 0,
    })
    if (location === undefined) return
    const persistenceRoot = dirname(location.path)
    if (pathsOverlap(this.config.stateRoot, persistenceRoot)) {
      throw new Error('agents-anywhere bridge stateRoot must not overlap the DSH Session persistence root')
    }
  }

  private requireCatalogs(): CatalogManager {
    if (this.catalogs === undefined) throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'Catalog services are not initialized.', { retryable: true })
    return this.catalogs
  }

  private requireSessions(): SessionManager {
    if (this.sessions === undefined) throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'Session services are not initialized.', { retryable: true })
    return this.sessions
  }

}

function runtimeCapabilitiesPayload(): Record<string, unknown> {
  return {
    runtime: RUNTIME_ID,
    revision: RUNTIME_CAPABILITIES_REVISION,
    capabilities: runtimeCapabilities(),
  }
}

function modelCatalogPayload(
  revision: number,
  models: Awaited<ReturnType<CatalogManager['current']>>['models'],
): Record<string, unknown> {
  return {
    runtime: RUNTIME_ID,
    revision,
    models: models.map(item => ({
      id: item.selectionId,
      title: item.name,
      selectionId: item.selectionId,
      ...(item.description === undefined ? {} : { description: item.description }),
      enabled: item.enabled,
      ...(item.disabledReason === undefined ? {} : { disabledReason: item.disabledReason }),
      metadata: {
        provider: item.provider,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        ...(item.contextWindow === undefined ? {} : { contextWindow: item.contextWindow }),
        ...(item.inputModalities === undefined ? {} : { inputModalities: item.inputModalities }),
      },
    })),
  }
}

function permissionCatalogPayload(
  revision: number,
  permissions: Awaited<ReturnType<CatalogManager['current']>>['permissions'],
): Record<string, unknown> {
  return {
    runtime: RUNTIME_ID,
    revision,
    permissions: permissions.map(item => ({
      id: item.preset,
      title: item.name,
      selectionId: item.selectionId,
      ...(item.description === undefined ? {} : { description: item.description }),
      enabled: item.enabled,
      metadata: { preset: item.preset },
    })),
  }
}

function sessionPair(params: Record<string, unknown>): { sessionId: string; externalSessionId: string } {
  return {
    sessionId: stringField(params, 'sessionId'),
    externalSessionId: stringField(params, 'externalSessionId'),
  }
}

function selectionsField(params: Record<string, unknown>): RequestedSelections | undefined {
  const value = params.selections
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new BridgeError('INVALID_PARAMS', 'selections must be an object.', { retryable: false })
  const model = optionalStringField(value, 'model')
  const permission = optionalStringField(value, 'permission')
  return { ...(model === undefined ? {} : { model }), ...(permission === undefined ? {} : { permission }) }
}

function requiredSelections(params: Record<string, unknown>): RequestedSelections {
  const selections = selectionsField(params)
  if (selections === undefined || (selections.model === undefined && selections.permission === undefined)) {
    throw new BridgeError('INVALID_PARAMS', 'At least one selection must be supplied.', { retryable: false })
  }
  return selections
}

function nonNegativeInteger(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key]
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BridgeError('INVALID_PARAMS', `${key} must be a non-negative safe integer.`, { retryable: false })
  }
  return value as number
}

function validRequestId(value: unknown): value is JsonRpcId {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isSafeInteger(value))
}

function isWriteMethod(method: string): boolean {
  return method.startsWith('session.create')
    || method.startsWith('session.start')
    || method === 'session.steer'
    || method === 'session.interrupt'
    || method === 'session.updateSelections'
    || method === 'session.executeCommand'
    || method === 'session.respondInteraction'
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new BridgeError('REQUEST_TIMEOUT', 'The bridge request timed out.', { retryable: true })
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation, expired])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('shutdown deadline exceeded')), timeoutMs)
  })
  try {
    return await Promise.race([operation, expired])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right)
  const rightToLeft = relative(right, left)
  return leftToRight === '' || (!leftToRight.startsWith('..') && !isAbsolute(leftToRight))
    || (!rightToLeft.startsWith('..') && !isAbsolute(rightToLeft))
}

function once(operation: () => void): () => void {
  let called = false
  return () => {
    if (called) return
    called = true
    operation()
  }
}

export default AgentsAnywhereBridgeService
