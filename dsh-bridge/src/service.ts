import { createRequire } from 'node:module'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { prepareStateLayout, type StateLayout } from './security/paths.js'
import { BridgeError } from './wire/errors.js'
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, RUNTIME_ID } from './wire/protocol.js'
import { LoopbackJsonRpcServer } from './wire/server.js'
import type {
  BridgeRequestHandler,
  JsonRpcNotification,
  JsonRpcRequest,
} from './wire/types.js'
import { objectField, stringField } from './wire/validation.js'

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

  private readonly config: ResolvedConfig
  private layout: StateLayout | undefined
  private endpoint: LoopbackJsonRpcServer | undefined
  private initialized = false
  private shuttingDown = false
  private readonly activeRequests = new Map<string, AbortController>()

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
    const endpoint = new LoopbackJsonRpcServer(layout, this.config.authenticationDeadlineMs, this)
    await endpoint.start()
    this.endpoint = endpoint
    this.ctx.effect(() => async () => {
      await this.stopBridge('service-dispose')
    }, 'agentsAnywhereBridge.lifecycle()')
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
  }

  async fatal(error: Error): Promise<void> {
    this.ctx.logger.warn(`Agents Anywhere bridge connection failed: ${error.name}`)
  }

  private async dispatch(frame: JsonRpcRequest, _signal: AbortSignal): Promise<unknown> {
    switch (frame.method) {
      case 'initialize':
        return this.initialize(frame.params)
      case 'runtime.getConfig':
        return runtimeConfigPayload(this.requireLayout(), this.config)
      case 'runtime.getCapabilities':
        return runtimeCapabilitiesPayload()
      case 'catalog.listModels':
        return { runtime: RUNTIME_ID, revision: 0, models: [] }
      case 'catalog.listPermissions':
        return { runtime: RUNTIME_ID, revision: 0, permissions: [] }
      case 'session.list':
        return { sessions: [], nextCursor: null }
      case 'ping':
        return {
          nonce: frame.params.nonce ?? null,
          initialized: this.initialized,
          shuttingDown: this.shuttingDown,
        }
      case 'shutdown':
        this.shuttingDown = true
        setImmediate(() => {
          this.stopBridge('connector-request').catch(error => this.fatal(error as Error))
        })
        return { ok: true, reason: 'connector-request' }
      default:
        throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'DSH Host integration is not initialized.', {
          retryable: true,
        })
    }
  }

  private initialize(params: Record<string, unknown>): Record<string, unknown> {
    if (this.initialized) {
      throw new BridgeError('INVALID_REQUEST', 'initialize may be called only once.', { retryable: false })
    }
    const protocolVersion = stringField(params, 'protocolVersion')
    if (!/^\d+\.\d+$/u.test(protocolVersion)) {
      throw new BridgeError('INVALID_PARAMS', 'protocolVersion must use major.minor notation.', { retryable: false })
    }
    if (protocolVersion.split('.')[0] !== PROTOCOL_VERSION.split('.')[0]) {
      throw new BridgeError('PROTOCOL_VERSION_MISMATCH', 'Bridge protocol major versions are incompatible.', { retryable: false })
    }
    if (stringField(params, 'runtime') !== RUNTIME_ID) {
      throw new BridgeError('UNSUPPORTED_OPERATION', 'This bridge exposes only the dsh runtime.', { retryable: false })
    }
    stringField(params, 'connectorId')
    const clientInfo = objectField(params, 'clientInfo')
    stringField(clientInfo, 'name')
    stringField(clientInfo, 'version')
    this.initialized = true
    return initializeResultPayload()
  }

  private async stopBridge(reason: string): Promise<void> {
    if (!this.shuttingDown) this.shuttingDown = true
    for (const controller of this.activeRequests.values()) controller.abort(abortError(`bridge shutdown: ${reason}`))
    this.activeRequests.clear()
    const endpoint = this.endpoint
    this.endpoint = undefined
    await endpoint?.stop()
    this.initialized = false
  }

  private requireLayout(): StateLayout {
    if (this.layout === undefined) throw new Error('bridge state layout is not initialized')
    return this.layout
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
      userQuestions: true,
    },
    transport: {
      framing: 'ndjson',
      maxFrameBytes: MAX_FRAME_BYTES,
      ownership: 'single-authenticated-connector',
    },
  }
}

export function runtimeCapabilitiesPayload(): Record<string, unknown> {
  const runtimeCapabilities = [
    'runtime.config',
    'catalog.model',
    'catalog.permission',
    'catalog.effort',
  ]
  return {
    runtime: RUNTIME_ID,
    revision: RUNTIME_CAPABILITIES_REVISION,
    capabilities: runtimeCapabilities.map(capabilityId => ({
      capabilityId,
      scope: 'runtime',
      runtime: RUNTIME_ID,
      supported: true,
      available: true,
      allowed: true,
    })),
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
    },
  }
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
        reject(new BridgeError('REQUEST_TIMEOUT', 'The bridge request timed out.', { retryable: true }, { cause: error }))
      }, timeoutMs)
      timer.unref()
    })
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export default AgentsAnywhereBridgeService
