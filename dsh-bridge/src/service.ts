import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative } from 'node:path'
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
import { MetadataStore } from './persistence/metadata.js'
import { CatalogManager, type CatalogSnapshot } from './runtime/catalogs.js'
import { runtimeCapabilities } from './runtime/capabilities.js'
import { InteractionManager } from './runtime/interactions.js'
import { SessionManager, type RequestedSelections } from './runtime/sessions.js'
import { ProcessLock } from './security/process-lock.js'
import { prepareStateLayout, type StateLayout } from './security/paths.js'
import { BridgeError } from './wire/errors.js'
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, RUNTIME_ID } from './wire/protocol.js'
import type { OutboundNotificationMethod } from './wire/protocol.js'
import { LoopbackJsonRpcServer } from './wire/server.js'
import type { BridgeRequestHandler, JsonRpcNotification, JsonRpcRequest } from './wire/types.js'
import {
  arrayField,
  isRecord,
  limitField,
  objectField,
  optionalBooleanField,
  optionalStringField,
  stringField,
} from './wire/validation.js'

const require = createRequire(import.meta.url)
const BRIDGE_VERSION = (require('../package.json') as { version: string }).version
const DSH_RUNTIME_VERSION = (require('@deepseek-ai/dsh-agent/package.json') as { version: string }).version
const RUNTIME_CAPABILITIES_REVISION = 1

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentsAnywhereBridge: AgentsAnywhereBridgeService
  }
}

export interface Config {
  dshHome?: string
  stateRoot?: string
  authenticationDeadlineMs?: number
  readRequestTimeoutMs?: number
  writeRequestTimeoutMs?: number
  shutdownTimeoutMs?: number
  maxListLimit?: number
  maxCommandLimit?: number
  maxPendingInteractions?: number
}

interface ResolvedConfig {
  dshHome: string
  stateRoot: string
  authenticationDeadlineMs: number
  readRequestTimeoutMs: number
  writeRequestTimeoutMs: number
  shutdownTimeoutMs: number
  maxListLimit: number
  maxCommandLimit: number
  maxPendingInteractions: number
}

export class AgentsAnywhereBridgeService extends Service implements BridgeRequestHandler {
  static Config: z<Config> = z.object({
    dshHome: z.string().required(),
    stateRoot: z.string().required(),
    authenticationDeadlineMs: z.natural().min(100).max(60_000).default(5_000),
    readRequestTimeoutMs: z.natural().min(100).max(600_000).default(30_000),
    writeRequestTimeoutMs: z.natural().min(100).max(600_000).default(60_000),
    shutdownTimeoutMs: z.natural().min(100).max(600_000).default(15_000),
    maxListLimit: z.natural().min(1).max(10_000).default(500),
    maxCommandLimit: z.natural().min(1).max(1_000).default(200),
    maxPendingInteractions: z.natural().min(1).max(1_000).default(64),
  })

  static inject = [
    'agents',
    'sessions',
    'sessionPersistence',
    'llm',
    'agentDefaultModel',
    'commands',
    'permissionPresets',
    'approval',
  ]

  private readonly config: ResolvedConfig
  private readonly activeRequests = new Map<string, AbortController>()
  private layout: StateLayout | undefined
  private processLock: ProcessLock | undefined
  private endpoint: LoopbackJsonRpcServer | undefined
  private catalogs: CatalogManager | undefined
  private sessions: SessionManager | undefined
  private interactions: InteractionManager | undefined
  private disposeRegistrations: (() => void) | undefined
  private initialized = false
  private connectorId: string | undefined
  private shuttingDown = false
  private shutdownPromise: Promise<Record<string, unknown>> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentsAnywhereBridge')
    if (config.dshHome === undefined || config.stateRoot === undefined) {
      throw new Error('dshHome and stateRoot are required')
    }
    this.config = {
      dshHome: config.dshHome,
      stateRoot: config.stateRoot,
      authenticationDeadlineMs: config.authenticationDeadlineMs ?? 5_000,
      readRequestTimeoutMs: config.readRequestTimeoutMs ?? 30_000,
      writeRequestTimeoutMs: config.writeRequestTimeoutMs ?? 60_000,
      shutdownTimeoutMs: config.shutdownTimeoutMs ?? 15_000,
      maxListLimit: config.maxListLimit ?? 500,
      maxCommandLimit: config.maxCommandLimit ?? 200,
      maxPendingInteractions: config.maxPendingInteractions ?? 64,
    }
  }

  protected async [Service.init](): Promise<void> {
    const layout = await prepareStateLayout(this.config.dshHome, this.config.stateRoot)
    this.layout = layout
    this.validatePersistenceSeparation(layout)
    const processLock = new ProcessLock(layout.lockPath, layout.dshHome)
    await processLock.acquire()
    this.processLock = processLock
    try {
      const metadata = new MetadataStore(layout.stateRoot)
      await metadata.initialize()
      await this.ctx.sessionPersistence.listSnapshots()
      const catalogs = new CatalogManager(this.ctx, metadata)
      await catalogs.refresh()
      this.catalogs = catalogs
      const sessions = new SessionManager(
        this.ctx,
        metadata,
        catalogs,
        this.config.maxListLimit,
        this.config.maxCommandLimit,
        (method, params) => this.notify(method, params),
      )
      const interactions = new InteractionManager(
        this.ctx,
        this.config.maxPendingInteractions,
        agent => sessions.controllerForAgent(agent),
        () => this.initialized && !this.shuttingDown,
        notice => this.notify('notice.upsert', notice as unknown as Record<string, unknown>),
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
        disposeInteractions()
        disposeObservers()
      })
      const endpoint = new LoopbackJsonRpcServer(
        layout,
        this.config.authenticationDeadlineMs,
        this,
        processLock,
      )
      await endpoint.start()
      this.endpoint = endpoint
      this.ctx.effect(() => async () => {
        await this.shutdownCore('service-dispose')
      }, 'agentsAnywhereBridge.lifecycle()')
    } catch (error: unknown) {
      this.disposeRegistrations?.()
      this.disposeRegistrations = undefined
      await this.endpoint?.stop().catch(() => undefined)
      this.endpoint = undefined
      await processLock.release().catch(() => undefined)
      this.processLock = undefined
      throw error
    }
  }

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
      return await withTimeout(this.dispatch(frame, controller.signal), timeoutMs, controller)
    } finally {
      this.activeRequests.delete(requestKey)
    }
  }

  async notification(frame: JsonRpcNotification): Promise<void> {
    const id = frame.params.id
    if ((typeof id !== 'string' || id.length === 0)
      && (typeof id !== 'number' || !Number.isSafeInteger(id))) {
      throw new BridgeError('INVALID_PARAMS', '$/cancelRequest requires a valid id.', { retryable: false })
    }
    this.activeRequests.get(`${typeof id}:${String(id)}`)?.abort(abortError('request cancelled by Connector'))
  }

  async disconnected(reason: string): Promise<void> {
    for (const controller of this.activeRequests.values()) controller.abort(abortError(reason))
    this.activeRequests.clear()
    this.initialized = false
    this.connectorId = undefined
    await this.interactions?.cancelAll()
  }

  async fatal(error: Error): Promise<void> {
    this.ctx.logger.warn(`Agents Anywhere Bridge connection failed: ${error.name}`)
  }

  private async dispatch(frame: JsonRpcRequest, signal: AbortSignal): Promise<unknown> {
    const params = frame.params
    switch (frame.method) {
      case 'initialize':
        return await this.initialize(params)
      case 'runtime.getConfig':
        return runtimeConfigPayload(this.requireLayout(), this.config)
      case 'runtime.getCapabilities':
        return runtimeCapabilitiesPayload()
      case 'catalog.listModels': {
        const snapshot = await this.requireCatalogs().current()
        const query = optionalStringField(params, 'query')?.toLocaleLowerCase()
        const limit = limitField(params, 'limit', this.config.maxListLimit, this.config.maxListLimit)
        return modelCatalogPayload(snapshot.revision, snapshot.models.filter(item => query === undefined
          || item.title.toLocaleLowerCase().includes(query)
          || String(item.metadata.provider).toLocaleLowerCase().includes(query)
          || String(item.metadata.model).toLocaleLowerCase().includes(query)).slice(0, limit))
      }
      case 'catalog.listPermissions': {
        const snapshot = await this.requireCatalogs().current()
        const query = optionalStringField(params, 'query')?.toLocaleLowerCase()
        const limit = limitField(params, 'limit', this.config.maxListLimit, this.config.maxListLimit)
        return permissionCatalogPayload(snapshot.revision, snapshot.permissions.filter(item => query === undefined
          || item.title.toLocaleLowerCase().includes(query)
          || item.id.toLocaleLowerCase().includes(query)).slice(0, limit))
      }
      case 'session.list':
        return await this.requireSessions().listSessions(
          limitField(params, 'limit', Math.min(100, this.config.maxListLimit), this.config.maxListLimit),
          optionalStringField(params, 'cursor'),
          optionalBooleanField(params, 'force') ?? false,
          signal,
        )
      case 'session.getSnapshot': {
        const pair = sessionPair(params)
        return await this.requireSessions().snapshot(
          pair.sessionId,
          pair.externalSessionId,
          nonNegativeInteger(params, 'fromSeq', 0),
          limitField(params, 'limit', this.config.maxListLimit, this.config.maxListLimit),
          signal,
        )
      }
      case 'session.getState': {
        const pair = sessionPair(params)
        return await this.requireSessions().state(pair.sessionId, pair.externalSessionId, signal)
      }
      case 'session.getNotices': {
        const pair = sessionPair(params)
        return await this.requireSessions().notices(pair.sessionId, pair.externalSessionId, signal)
      }
      case 'session.getCapabilities': {
        const pair = sessionPair(params)
        return await this.requireSessions().capabilities(pair.sessionId, pair.externalSessionId, signal)
      }
      case 'session.createAndStart': {
        const attachments = arrayField(params, 'attachments')
        if (attachments.length > 0) {
          throw new BridgeError('UNSUPPORTED_OPERATION', 'Attachments are not supported by Bridge protocol 1.0.', {
            retryable: false,
          })
        }
        const selections = selectionsField(params)
        return await this.requireSessions().createAndStart({
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
        return await this.requireSessions().startTurn({
          ...pair,
          content: stringField(params, 'content'),
          clientMessageId: stringField(params, 'clientMessageId'),
          ...(selections === undefined ? {} : { selections }),
        }, signal)
      }
      case 'session.steer': {
        const pair = sessionPair(params)
        return await this.requireSessions().steer({
          ...pair,
          content: stringField(params, 'content'),
          clientMessageId: stringField(params, 'clientMessageId'),
        }, signal)
      }
      case 'session.interrupt': {
        const pair = sessionPair(params)
        return await this.requireSessions().interrupt(pair.sessionId, pair.externalSessionId, signal)
      }
      case 'session.updateSelections': {
        const pair = sessionPair(params)
        return await this.requireSessions().updateSelections(
          pair.sessionId,
          pair.externalSessionId,
          requiredSelections(params),
          signal,
        )
      }
      case 'session.listCommands': {
        const pair = sessionPair(params)
        return await this.requireSessions().listCommands(
          pair.sessionId,
          pair.externalSessionId,
          optionalStringField(params, 'query'),
          limitField(params, 'limit', Math.min(100, this.config.maxCommandLimit), this.config.maxCommandLimit),
          signal,
        )
      }
      case 'session.executeCommand': {
        const pair = sessionPair(params)
        return await this.requireSessions().executeCommand(
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
        return await this.requireSessions().respondInteraction(
          pair.sessionId,
          pair.externalSessionId,
          stringField(params, 'noticeId'),
          stringField(params, 'actionId'),
          signal,
        )
      }
      case 'ping':
        return { nonce: params.nonce ?? null, initialized: this.initialized, shuttingDown: this.shuttingDown }
      case 'shutdown':
        this.shuttingDown = true
        setImmediate(() => {
          void (async () => {
            await this.endpoint?.flush()
            await this.shutdownCore('connector-request')
          })().catch(error => this.fatal(error as Error))
        })
        return { ok: true, reason: 'connector-request' }
    }
  }

  private async initialize(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.initialized) {
      throw new BridgeError('INVALID_REQUEST', 'initialize may be called only once.', { retryable: false })
    }
    const protocolVersion = stringField(params, 'protocolVersion')
    if (!/^\d+\.\d+$/u.test(protocolVersion)) {
      throw new BridgeError('INVALID_PARAMS', 'protocolVersion must use major.minor notation.', { retryable: false })
    }
    if (protocolVersion.split('.')[0] !== PROTOCOL_VERSION.split('.')[0]) {
      throw new BridgeError('PROTOCOL_VERSION_MISMATCH', 'Bridge protocol major versions are incompatible.', {
        retryable: false,
      })
    }
    if (stringField(params, 'runtime') !== RUNTIME_ID) {
      throw new BridgeError('UNSUPPORTED_OPERATION', 'Bridge wire provider must be dsh.', { retryable: false })
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
        .catch(error => this.fatal(error as Error))
    })
    return initializeResultPayload()
  }

  private async publishCatalogs(snapshot: CatalogSnapshot): Promise<void> {
    if (!this.initialized) return
    await this.notify('catalog.model.update', modelCatalogPayload(snapshot.revision, snapshot.models))
    await this.notify('catalog.permission.update', permissionCatalogPayload(snapshot.revision, snapshot.permissions))
  }

  private async notify(method: OutboundNotificationMethod, params: Record<string, unknown>): Promise<void> {
    if (!this.initialized) {
      throw new BridgeError('NOT_INITIALIZED', 'No initialized Connector owns the bridge.', { retryable: true })
    }
    const endpoint = this.endpoint
    if (endpoint === undefined) {
      throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'Bridge endpoint is unavailable.', { retryable: true })
    }
    await endpoint.notify(method, params)
  }

  private shutdownCore(reason: string): Promise<Record<string, unknown>> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise
    this.shuttingDown = true
    for (const controller of this.activeRequests.values()) controller.abort(abortError(`bridge shutdown: ${reason}`))
    const operation = (async (): Promise<Record<string, unknown>> => {
      await this.interactions?.cancelAll()
      const result = await withDeadline(
        this.sessions?.shutdown() ?? Promise.resolve({ disposedSessions: 0, failedSessions: 0 }),
        this.config.shutdownTimeoutMs,
      ).catch(() => ({ disposedSessions: 0, failedSessions: 1 }))
      this.disposeRegistrations?.()
      this.disposeRegistrations = undefined
      const endpoint = this.endpoint
      this.endpoint = undefined
      await endpoint?.stop()
      const lock = this.processLock
      this.processLock = undefined
      await lock?.release()
      this.initialized = false
      this.connectorId = undefined
      return { ok: result.failedSessions === 0, reason, ...result }
    })()
    this.shutdownPromise = operation
    return operation
  }

  private validatePersistenceSeparation(layout: StateLayout): void {
    const location = this.ctx.sessionPersistence.locate({
      version: SESSION_FORMAT_VERSION,
      id: SessionId('aa-bridge-location-probe'),
      createdAt: 0,
    })
    if (location === undefined) return
    const persistenceRoot = dirname(location.path)
    if (pathsOverlap(layout.stateRoot, persistenceRoot)) {
      throw new Error('stateRoot must not overlap the DSH Session persistence root')
    }
  }

  private requireLayout(): StateLayout {
    if (this.layout === undefined) throw new Error('bridge state layout is not initialized')
    return this.layout
  }

  private requireCatalogs(): CatalogManager {
    if (this.catalogs === undefined) {
      throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'DSH catalog services are unavailable.', { retryable: true })
    }
    return this.catalogs
  }

  private requireSessions(): SessionManager {
    if (this.sessions === undefined) {
      throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'DSH Session services are unavailable.', { retryable: true })
    }
    return this.sessions
  }
}

export function initializeResultPayload(): Record<string, unknown> {
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
      userQuestions: false,
    },
    transport: {
      framing: 'ndjson',
      maxFrameBytes: MAX_FRAME_BYTES,
      ownership: 'single-authenticated-connector',
    },
  }
}

export function runtimeCapabilitiesPayload(): Record<string, unknown> {
  return {
    runtime: RUNTIME_ID,
    revision: RUNTIME_CAPABILITIES_REVISION,
    capabilities: runtimeCapabilities(),
  }
}

function runtimeConfigPayload(layout: StateLayout, config: ResolvedConfig): Record<string, unknown> {
  return {
    runtime: RUNTIME_ID,
    protocolVersion: PROTOCOL_VERSION,
    bridgeVersion: BRIDGE_VERSION,
    config: {
      authenticationDeadlineMs: config.authenticationDeadlineMs,
      readRequestTimeoutMs: config.readRequestTimeoutMs,
      writeRequestTimeoutMs: config.writeRequestTimeoutMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      maxListLimit: config.maxListLimit,
      maxCommandLimit: config.maxCommandLimit,
      maxPendingInteractions: config.maxPendingInteractions,
    },
    metadata: {
      storageMode: 'dsh-native',
      sameSessionWriterLimit: 1,
      crossProcessWriterExclusion: false,
      dshHome: layout.dshHome,
      stateRoot: layout.stateRoot,
      maxFrameBytes: MAX_FRAME_BYTES,
      wireProvider: RUNTIME_ID,
      instanceBindingOwner: 'connector',
    },
  }
}

function modelCatalogPayload(revision: number, models: CatalogSnapshot['models']): Record<string, unknown> {
  return { runtime: RUNTIME_ID, revision, models }
}

function permissionCatalogPayload(
  revision: number,
  permissions: CatalogSnapshot['permissions'],
): Record<string, unknown> {
  return { runtime: RUNTIME_ID, revision, permissions }
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
  if (!isRecord(value)) {
    throw new BridgeError('INVALID_PARAMS', 'selections must be an object.', { retryable: false })
  }
  const model = optionalStringField(value, 'model')
  const permission = optionalStringField(value, 'permission')
  return {
    ...(model === undefined ? {} : { model }),
    ...(permission === undefined ? {} : { permission }),
  }
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

function isWriteMethod(method: string): boolean {
  return method.startsWith('session.')
    && !method.startsWith('session.get')
    && method !== 'session.list'
    && method !== 'session.listCommands'
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = abortError('bridge request timed out')
        controller.abort(error)
        reject(new BridgeError('REQUEST_TIMEOUT', 'The bridge request timed out.', {
          retryable: true,
        }, { cause: error }))
      }, timeoutMs)
      timer.unref()
    })
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('shutdown deadline exceeded')), timeoutMs)
    timer.unref()
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right)
  const rightToLeft = relative(right, left)
  return isSameOrChild(leftToRight) || isSameOrChild(rightToLeft)
}

function isSameOrChild(relation: string): boolean {
  const separator = process.platform === 'win32' ? '\\' : '/'
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${separator}`) && !isAbsolute(relation))
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
