import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
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
import { MetadataStore } from './bridge/persistence/metadata.js'
import { CatalogManager } from './bridge/runtime/catalogs.js'
import { runtimeCapabilities } from './bridge/runtime/capabilities.js'
import { InteractionManager } from './bridge/runtime/interactions.js'
import { SessionManager, type RequestedSelections } from './bridge/runtime/sessions.js'
import { BridgeError } from './bridge/wire/errors.js'
import {
  PROTOCOL_VERSION,
  RUNTIME_ID,
} from './bridge/wire/protocol.js'
import { LoopbackJsonRpcServer, type LoopbackServerHandler } from './bridge/wire/server.js'
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest } from './bridge/wire/types.js'
import {
  arrayField,
  isRecord,
  limitField,
  objectField,
  optionalBooleanField,
  optionalStringField,
  stringField,
} from './bridge/wire/validation.js'
import {
  type AppDownloadQrInfo,
  type BridgeInfo,
  type ConnectorCredentials,
  type ConnectorHostApi,
  type ConnectorLog,
  type ConnectorLogChunk,
  type ConnectorStateSnapshot,
  type EnvironmentInfo,
  INITIAL_ENVIRONMENT,
  INITIAL_OAUTH,
  INITIAL_PAIRING,
  type MobileLoginQrData,
  type MobileLoginStatusInfo,
  type OperationResult,
  type PairingStartResult,
  type PairingState,
} from './common/types.js'
import { ConnectorCoordinator } from './manager/connector-coordinator.js'

const MAX_FRAME_BYTES = 32 * 1024 * 1024
const PLUGIN_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version
const RUNTIME_CAPABILITIES_REVISION = 1
const DSH_RUNTIME_VERSION = (createRequire(import.meta.url)('@deepseek-ai/dsh-agent/package.json') as { version: string }).version

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentsAnywhereConnector: AgentsAnywhereConnectorService
  }
}

/** Deployment-tunable bridge settings nested under the plugin's `bridge` config. */
export interface Config {
  bridge?: BridgeConfig
}

export interface BridgeConfig {
  stateRoot?: string
  maxFrameBytes?: number
  readRequestTimeoutMs?: number
  writeRequestTimeoutMs?: number
  shutdownTimeoutMs?: number
  maxListLimit?: number
  maxCommandLimit?: number
  maxPendingInteractions?: number
  /**
   * Working directory for the spawned `anywhere-cli start` subprocess.
   * Defaults to `Agents-Anywhere/connector`.
   */
  connectorCwd?: string
}

interface ResolvedBridgeConfig {
  stateRoot: string
  maxFrameBytes: number
  readRequestTimeoutMs: number
  writeRequestTimeoutMs: number
  shutdownTimeoutMs: number
  maxListLimit: number
  maxCommandLimit: number
  maxPendingInteractions: number
  connectorCwd: string
}

/** Agents Anywhere host service embedded inside the DSH Web/Desktop process. */
export class AgentsAnywhereConnectorService extends TypertRemoteService implements LoopbackServerHandler {
  static Config: z<Config> = z.object({
    bridge: z.object({
      stateRoot: z.string().required(),
      maxFrameBytes: z.natural().min(1).max(MAX_FRAME_BYTES).default(8 * 1024 * 1024),
      readRequestTimeoutMs: z.natural().min(1).default(30_000),
      writeRequestTimeoutMs: z.natural().min(1).default(60_000),
      shutdownTimeoutMs: z.natural().min(1).default(15_000),
      maxListLimit: z.natural().min(1).default(500),
      maxCommandLimit: z.natural().min(1).default(200),
      maxPendingInteractions: z.natural().min(1).default(64),
      connectorCwd: z.string(),
    }).required(),
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

  private readonly config: ResolvedBridgeConfig
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

  /** Validate composition, register reversible resources, and start the loopback endpoint. */
  async [Service.init](): Promise<void> {
    this.ctx.effect(() => async () => {
      await this.shutdownCore('service-dispose')
    }, 'agentsAnywhereConnector.lifecycle()')
    try {
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
      const workspaceBackfill = await sessions.backfillWorkspaceMembership()
      if (workspaceBackfill.failedSessions > 0) {
        this.ctx.logger.warn(
          `Agents Anywhere bridge workspace backfill left ${workspaceBackfill.failedSessions} Session(s) ungrouped.`,
        )
      }
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
      const registrations: Array<() => void> = []
      this.disposeRegistrations = once(() => {
        for (const dispose of registrations.splice(0).reverse()) {
          try {
            dispose()
          } catch (error: unknown) {
            this.ctx.logger.warn(`Agents Anywhere bridge registration cleanup failed: ${errorMessage(error)}`)
          }
        }
      })
      registrations.push(sessions.registerObservers())
      registrations.push(interactions.register())
      registrations.push(this.ctx.on('llm/adapters-updated', async () => {
        const snapshot = await catalogs.refresh()
        await this.publishCatalogs(snapshot)
      }))
      const endpoint = new LoopbackJsonRpcServer(this.config.stateRoot, this.config.maxFrameBytes, this)
      this.endpoint = endpoint
      await endpoint.start()

      // Auto-start the connector when `autoStart` is enabled (default on). This
      // re-spawns `anywhere-cli rpc` and re-reads the saved credential, so the
      // paired device + running state survive a DSH restart without the user
      // having to click Start again.
      if (this.connectorState.environment.autoStart) {
        void this.start().catch((error: unknown) => {
          this.ctx.logger.warn(`Agents Anywhere connector auto-start failed: ${errorMessage(error)}`)
        })
      }
    } catch (error: unknown) {
      await this.shutdownCore('service-init-failed')
      throw error
    }
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

  /** Reset connection state after a Connector disconnect without stopping DSH Web. */
  async eof(): Promise<void> {
    await this.disconnected('connector-eof')
  }

  /** Log an unrecoverable connection failure without stopping DSH Web. */
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

  /** Absolute loopback port bound for the Connector to attach to. */
  getBridgePort(): number | undefined {
    return this.endpoint?.port
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
          bridgeVersion: PLUGIN_VERSION,
          config: { ...this.config },
          metadata: {
            storageMode: 'dsh-native',
            sameSessionWriterLimit: 1,
            crossProcessWriterExclusion: false,
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
    this.runBackground('initial catalog publication', async () => {
      await this.publishCatalogs(catalogs)
      await this.notify('runtime.capabilities.update', runtimeCapabilitiesPayload())
    })
    return {
      identity: {
        runtime: RUNTIME_ID,
        runtimeVersion: DSH_RUNTIME_VERSION,
        bridgeVersion: PLUGIN_VERSION,
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

  private runBackground(label: string, operation: () => Promise<void>): void {
    setImmediate(() => {
      void operation().catch((error: unknown) => {
        this.ctx.logger.warn(`Agents Anywhere bridge ${label} failed: ${errorMessage(error)}`)
      })
    })
  }

  private shutdownCore(reason: string): Promise<Record<string, unknown>> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise
    this.shuttingDown = true
    for (const controller of this.activeRequests.values()) controller.abort(new Error(`bridge shutdown: ${reason}`))
    const operation = (async (): Promise<Record<string, unknown>> => {
      this.disposeRegistrations?.()
      this.disposeRegistrations = undefined
      let cleanupFailed = false
      await this.interactions?.cancelAll().catch((error: unknown) => {
        cleanupFailed = true
        this.ctx.logger.warn(`Agents Anywhere bridge interaction cleanup failed: ${errorMessage(error)}`)
      })
      const result = await withDeadline(
        this.sessions?.shutdown() ?? Promise.resolve({ disposedSessions: 0, failedSessions: 0 }),
        this.config.shutdownTimeoutMs,
      ).catch((error: unknown) => {
        cleanupFailed = true
        this.ctx.logger.warn(`Agents Anywhere bridge Session cleanup failed: ${errorMessage(error)}`)
        return { disposedSessions: 0, failedSessions: 1 }
      })
      await this.endpoint?.stop().catch((error: unknown) => {
        cleanupFailed = true
        this.ctx.logger.warn(`Agents Anywhere bridge endpoint cleanup failed: ${errorMessage(error)}`)
      })
      this.endpoint = undefined
      return { ok: result.failedSessions === 0 && !cleanupFailed, reason, ...result }
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

  // ─── Connector host coordination layer ─────────────────────────────────────
  //
  // The methods below implement the `ConnectorHostApi` contract consumed by the
  // DSH settings UI. The actual subprocess + JSON-RPC client live in
  // `ConnectorCoordinator`; this service hosts the coordinator lazily and
  // surfaces its state snapshot to the UI. The plugin keeps loading even when
  // `uv` is not installed — `start()` simply reports the missing binary
  // instead of throwing.

  private readonly connectorState: ConnectorStateSnapshot = {
    version: 1,
    runtime: 'running',
    runtimeError: null,
    connection: 'disconnected',
    bridge: null,
    device: null,
    account: null,
    oauth: { ...INITIAL_OAUTH },
    pairing: { ...INITIAL_PAIRING },
    environment: { ...INITIAL_ENVIRONMENT },
    dataDir: '~/.agents-anywhere',
    logBufferSize: 0,
  }

  private readonly logBuffer: ConnectorLog[] = []
  private readonly logBufferLimit = 500
  private readonly coordinator: ConnectorCoordinator
  private coordinatorWired = false

  /** Capture the bridge endpoint info once the loopback server starts. */
  private captureBridgeInfo(): BridgeInfo | null {
    const port = this.endpoint?.port
    if (port === undefined) return null
    return {
      port,
      pid: process.pid,
      activeSessions: 0,
      pushChannel: this.connectorId === undefined ? 'idle' : 'open',
    }
  }

  /**
   * Construct the service without claiming process streams.
   * @param ctx - Fully composed DSH base context.
   * @param config - Schema-validated plugin configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentsAnywhereConnector')
    // Register the connector control surface with the strict Typert registry
    // so `/api/agentsAnywhereConnector/*` resolves independently of the
    // gateway's SRC discovery (which computes its claim cache from `ctx.get`,
    // a strict call that can miss a still-loading service). This is the same
    // `ctx.inject(['typert'], …)` idiom used by dsh-agent / dsh-api-remotes.
    this.ctx.inject(['typert'], (typeCtx) => {
      try {
        const typert = typeCtx.typert as unknown as { register(contribution: unknown): unknown }
        typert.register(buildTypertContribution())
      } catch (error: unknown) {
        this.ctx.logger.warn(`Agents Anywhere Typert registration failed: ${errorMessage(error)}`)
      }
    })
    const bridge = config.bridge
    if (bridge === undefined || bridge.stateRoot === undefined || !isAbsolute(bridge.stateRoot)) {
      throw new Error('agents-anywhere bridge stateRoot must be an absolute path')
    }
    const connectorCwd = resolve(bridge.connectorCwd ?? defaultConnectorCwd())
    this.config = {
      stateRoot: resolve(bridge.stateRoot),
      maxFrameBytes: bridge.maxFrameBytes ?? 8 * 1024 * 1024,
      readRequestTimeoutMs: bridge.readRequestTimeoutMs ?? 30_000,
      writeRequestTimeoutMs: bridge.writeRequestTimeoutMs ?? 60_000,
      shutdownTimeoutMs: bridge.shutdownTimeoutMs ?? 15_000,
      maxListLimit: bridge.maxListLimit ?? 500,
      maxCommandLimit: bridge.maxCommandLimit ?? 200,
      maxPendingInteractions: bridge.maxPendingInteractions ?? 64,
      connectorCwd,
    }
    this.metadata = new MetadataStore(this.config.stateRoot)
    this.coordinator = new ConnectorCoordinator({ cwd: this.config.connectorCwd })
    this.wireCoordinatorEvents()
  }

  private patchState(patch: Partial<ConnectorStateSnapshot>): ConnectorStateSnapshot {
    Object.assign(this.connectorState, patch)
    this.connectorState.bridge = this.captureBridgeInfo()
    return { ...this.connectorState }
  }

  /** Build a fresh state snapshot from the latest bridge + local fields. */
  snapshotState(): ConnectorStateSnapshot {
    this.connectorState.bridge = this.captureBridgeInfo()
    return { ...this.connectorState }
  }

  // ── HostApi (Typert Remote) ──────────────────────────────────────────────
  //
  // These methods are exposed to the browser over DSH's shared `/api` RPC
  // channel through the Typert Gateway. `TypertRemoteService` (the base class)
  // binds the `agentsAnywhereConnector` namespace; each `@Remote('<name>')`
  // decorator exports the method as the endpoint `<namespace>/<name>`. The
  // client calls `connection.rpc.call('/api', 'agentsAnywhereConnector/<name>',
  // { args })`.

  @Remote('getState')
  async getState(): Promise<ConnectorStateSnapshot> {
    const liveSnapshot = await this.coordinator.getState()
    this.patchState(liveSnapshot)
    return this.snapshotState()
  }

  @Remote('start')
  async start(): Promise<OperationResult> {
    this.wireCoordinatorEvents()
    const result = await this.coordinator.start()
    return result
  }

  @Remote('stop')
  async stop(): Promise<OperationResult> {
    this.wireCoordinatorEvents()
    return this.coordinator.stop()
  }

  @Remote('restart')
  async restart(): Promise<OperationResult> {
    this.wireCoordinatorEvents()
    return this.coordinator.restart()
  }

  // ── HostApi: OAuth & Account ──
  @Remote('startOAuthLogin')
  async startOAuthLogin(serverUrl?: string): Promise<OperationResult> {
    this.wireCoordinatorEvents()
    return this.coordinator.startOAuthLogin(serverUrl)
  }

  @Remote('cancelOAuthLogin')
  async cancelOAuthLogin(): Promise<OperationResult> {
    this.wireCoordinatorEvents()
    return this.coordinator.cancelOAuthLogin()
  }

  @Remote('createMobileLoginQr')
  async createMobileLoginQr(): Promise<MobileLoginQrData | null> {
    this.wireCoordinatorEvents()
    return this.coordinator.createMobileLoginQr()
  }

  @Remote('getMobileLoginStatus')
  async getMobileLoginStatus(loginToken: string): Promise<MobileLoginStatusInfo | null> {
    this.wireCoordinatorEvents()
    return this.coordinator.getMobileLoginStatus(loginToken)
  }

  @Remote('confirmMobileLogin')
  async confirmMobileLogin(loginToken: string, approved: boolean): Promise<MobileLoginStatusInfo | null> {
    this.wireCoordinatorEvents()
    return this.coordinator.confirmMobileLogin(loginToken, approved)
  }

  @Remote('getAppDownloadQr')
  async getAppDownloadQr(serverUrl?: string): Promise<AppDownloadQrInfo | null> {
    this.wireCoordinatorEvents()
    return this.coordinator.getAppDownloadQr(serverUrl)
  }

  @Remote('logout')
  async logout(): Promise<OperationResult> {
    this.wireCoordinatorEvents()
    return this.coordinator.logout()
  }

  // ── HostApi: pairing ──
  @Remote('startPairing')
  async startPairing(serverUrl?: string): Promise<PairingStartResult> {
    this.wireCoordinatorEvents()
    return this.coordinator.startPairing(serverUrl)
  }

  @Remote('cancelPairing')
  async cancelPairing(): Promise<OperationResult> {
    this.wireCoordinatorEvents()
    return this.coordinator.cancelPairing()
  }

  @Remote('clearCredentials')
  async clearCredentials(): Promise<OperationResult> {
    this.wireCoordinatorEvents()
    return this.coordinator.clearCredentials()
  }

  @Remote('saveCredentials')
  async saveCredentials(credentials: ConnectorCredentials): Promise<OperationResult> {
    this.wireCoordinatorEvents()
    return this.coordinator.saveCredentials(credentials)
  }

  // ── HostApi: environment & settings ──
  @Remote('detectEnvironment')
  async detectEnvironment(): Promise<EnvironmentInfo> {
    return this.coordinator.detectEnvironment()
  }

  @Remote('saveEnvironment')
  async saveEnvironment(patch: Partial<EnvironmentInfo>): Promise<OperationResult> {
    return this.coordinator.saveEnvironment(patch)
  }

  // ── HostApi: logs ──
  @Remote('getLogs')
  async getLogs(options?: { offset?: number; limit?: number; level?: string }): Promise<ConnectorLogChunk> {
    return this.coordinator.getLogs(options)
  }

  @Remote('clearLogs')
  async clearLogs(): Promise<OperationResult> {
    return this.coordinator.clearLogs()
  }

  @Remote('openConfigDirectory')
  async openConfigDirectory(): Promise<OperationResult> {
    return this.coordinator.openConfigDirectory()
  }

  /** Push a synthetic log entry into the ring buffer (used by the Client demo ticker). */
  appendDemoLog(entry: ConnectorLog): void {
    this.logBuffer.push(entry)
    if (this.logBuffer.length > this.logBufferLimit) {
      this.logBuffer.splice(0, this.logBuffer.length - this.logBufferLimit)
    }
    this.connectorState.logBufferSize = this.logBuffer.length
  }

  /**
   * Forward coordinator events into the bridge-service state snapshot so
   * `snapshotState()` reflects the live subprocess on every read.
   */
  private wireCoordinatorEvents(): void {
    if (this.coordinatorWired) return
    this.coordinatorWired = true
    this.coordinator.on('state', (snapshot) => {
      Object.assign(this.connectorState, {
        runtime: snapshot.runtime,
        runtimeError: snapshot.runtimeError,
        connection: snapshot.connection,
        bridge: snapshot.bridge,
        device: snapshot.device,
        account: snapshot.account,
        oauth: snapshot.oauth,
        pairing: snapshot.pairing,
        environment: snapshot.environment,
        dataDir: snapshot.dataDir,
        logBufferSize: snapshot.logBufferSize,
      })
    })
    this.coordinator.on('log', (entry) => {
      this.logBuffer.push(entry)
      if (this.logBuffer.length > this.logBufferLimit) {
        this.logBuffer.splice(0, this.logBuffer.length - this.logBufferLimit)
      }
      this.connectorState.logBufferSize = this.logBuffer.length
    })
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build a minimal generated-style Typert contribution so the connector control
 * endpoints resolve through the strict `typert.local` registry, independent of
 * the gateway's SRC discovery cache. Descriptors mirror the SRC shape: direct
 * invocation, JSON wire fields, `src-json` result codec.
 */
function buildTypertContribution(): unknown {
  const noArg = (method: string) => ({
    id: `src:agentsAnywhereConnector#${method}`,
    service: 'agentsAnywhereConnector',
    namespace: 'agentsAnywhereConnector',
    method,
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'src-json' },
  })
  const withArg = (method: string, arg: string, optional: boolean) => ({
    id: `src:agentsAnywhereConnector#${method}`,
    service: 'agentsAnywhereConnector',
    namespace: 'agentsAnywhereConnector',
    method,
    invocation: { kind: 'direct' },
    parameters: [{
      name: arg,
      wire: arg,
      source: 'json',
      codec: { mode: 'src-json' },
      ...(optional ? { acceptsUndefined: true } : {}),
    }],
    result: { mode: 'src-json' },
  })
  return {
    package: '@agents-anywhere/dsh-aa-gateway',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      noArg('getState'),
      noArg('start'),
      noArg('stop'),
      noArg('restart'),
      withArg('startOAuthLogin', 'serverUrl', true),
      noArg('cancelOAuthLogin'),
      noArg('createMobileLoginQr'),
      withArg('getMobileLoginStatus', 'loginToken', false),
      {
        id: 'src:agentsAnywhereConnector#confirmMobileLogin',
        service: 'agentsAnywhereConnector',
        namespace: 'agentsAnywhereConnector',
        method: 'confirmMobileLogin',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'loginToken', wire: 'loginToken', source: 'json', codec: { mode: 'src-json' } },
          { name: 'approved', wire: 'approved', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      },
      withArg('getAppDownloadQr', 'serverUrl', true),
      noArg('logout'),
      withArg('startPairing', 'serverUrl', true),
      noArg('cancelPairing'),
      noArg('clearCredentials'),
      withArg('saveCredentials', 'credentials', false),
      noArg('detectEnvironment'),
      withArg('saveEnvironment', 'patch', false),
      withArg('getLogs', 'options', true),
      noArg('clearLogs'),
      noArg('openConfigDirectory'),
    ],
  }
}

/** Generate one 6-character uppercase pairing code. */
function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i += 1) {
    code += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }
  return code
}

/**
 * Resolve the `anywhere-cli` Python project directory.
 *
 * Resolution order:
 *   1. Sibling `../connector/` relative to `dsh-aa-gateway`
 *   2. Walking up parent directories for `connector/` or `Agents-Anywhere/connector/`
 *   3. `<process.cwd()>/connector` or `<process.cwd()>/Agents-Anywhere/connector`
 */
function defaultConnectorCwd(): string {
  const here = new URL(import.meta.url)
  const herePath = fileURLToPath(here)
  const candidates: string[] = [
    resolve(dirname(herePath), '..', 'connector'),
    resolve(dirname(herePath), '..', '..', 'connector'),
  ]
  // Walk up from the installed plugin location looking for `Agents-Anywhere/connector` or `connector`.
  for (let cursor = dirname(herePath); cursor !== '/' && cursor !== '.'; cursor = dirname(cursor)) {
    candidates.push(resolve(cursor, 'connector'))
    candidates.push(resolve(cursor, 'Agents-Anywhere', 'connector'))
  }
  // Always also try cwd.
  candidates.push(resolve(process.cwd(), 'connector'))
  candidates.push(resolve(process.cwd(), 'Agents-Anywhere', 'connector'))
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'pyproject.toml'))) return candidate
  }
  return resolve(dirname(herePath), '..', 'connector')
}

export default AgentsAnywhereConnectorService
