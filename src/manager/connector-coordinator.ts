/**
 * Connector CLI coordinator — owns the subprocess + JSON-RPC client and
 * projects them onto the `ConnectorHostApi` surface.
 *
 * Lifecycle:
 *   1. `start()` resolves uv via `EnvDetector`, spawns the CLI subprocess,
 *      dials the JSON-RPC handshake (`connector.getState`), and seeds the
 *      local snapshot from the response.
 *   2. `stop()` sends `connector.stop` via RPC and SIGTERMs the subprocess
 *      after a graceful deadline.
 *   3. `restart()` is a convenience wrapper.
 *
 * All failure modes funnel through `OperationResult` so the Cordis-side
 * service can surface a typed error to the UI without throwing.
 *
 * The coordinator owns the in-memory `ConnectorStateSnapshot` and a ring
 * buffer of `ConnectorLog` entries; these are what `getState` / `getLogs`
 * return. Push-side state updates ride on a small EventEmitter so the
 * Cordis-side service can fan them out to the wire.
 */

import { EventEmitter } from 'node:events'
import {
  type BridgeInfo,
  type ConnectorHostApi,
  type ConnectorLog,
  type ConnectorLogChunk,
  type ConnectorStateSnapshot,
  type EnvironmentInfo,
  INITIAL_ENVIRONMENT,
  INITIAL_PAIRING,
  type OperationResult,
  type PairingStartResult,
  type PairingState,
} from '../common/types.js'
import { EnvDetector, type UvResolutionResult } from './env-detector.js'
import { ProcessRunner, type CommandSpec, type ConnectorLogEvent } from './process-runner.js'
import { RpcClient, runnerToTransport } from './rpc-client.js'

export interface CoordinatorOptions {
  /** Optional factory for tests to inject a deterministic EnvDetector. */
  envDetectorFactory?: () => EnvDetector
  /** Working directory for the spawned CLI subprocess. */
  cwd?: string
  /** Subprocess graceful-stop deadline; forwarded to the runner. */
  gracefulStopMs?: number
}

export interface CoordinatorEvents {
  state: (snapshot: ConnectorStateSnapshot) => void
  log: (entry: ConnectorLog) => void
}

export declare interface ConnectorCoordinator {
  on<K extends keyof CoordinatorEvents>(event: K, listener: CoordinatorEvents[K]): this
  off<K extends keyof CoordinatorEvents>(event: K, listener: CoordinatorEvents[K]): this
  emit<K extends keyof CoordinatorEvents>(event: K, ...args: Parameters<CoordinatorEvents[K]>): boolean
}

const RPC_TIMEOUT_MS = 30_000
const LOG_BUFFER_LIMIT = 500

export class ConnectorCoordinator extends EventEmitter implements ConnectorHostApi {
  private readonly runner: ProcessRunner
  private client: RpcClient | null = null
  private snapshot: ConnectorStateSnapshot
  private readonly logs: ConnectorLog[] = []
  private envDetectorFactory: () => EnvDetector
  private readonly cwd: string
  private teardownInFlight = false

  constructor(options: CoordinatorOptions = {}) {
    super()
    this.runner = new ProcessRunner(
      options.gracefulStopMs === undefined
        ? {}
        : { gracefulStopMs: options.gracefulStopMs },
    )
    this.envDetectorFactory = options.envDetectorFactory ?? (() => new EnvDetector())
    this.cwd = options.cwd ?? process.cwd()
    this.snapshot = initialSnapshot()
    this.runner.on('state', (state) => this.handleRunnerState(state))
    this.runner.on('log', (entry) => this.handleRunnerLog(entry))
    this.runner.on('error', (error) => {
      this.snapshot = { ...this.snapshot, runtimeError: error.message }
      this.emit('state', this.snapshot)
    })
  }

  /** Read-only accessor used by the Cordis-side service. */
  getSnapshot(): ConnectorStateSnapshot {
    return { ...this.snapshot, logBufferSize: this.logs.length }
  }

  /** Replace the env detector factory (used by the Cordis service to inject options). */
  configureEnvDetector(factory: () => EnvDetector): void {
    this.envDetectorFactory = factory
  }

  async getState(): Promise<ConnectorStateSnapshot> {
    if (this.client !== null) {
      try {
        const remote = await this.client.send<ConnectorStateSnapshot>('connector.getState')
        this.snapshot = { ...this.snapshot, ...remote, logBufferSize: this.logs.length }
      } catch {
        // Fall through to local snapshot.
      }
    }
    return this.getSnapshot()
  }

  async start(): Promise<OperationResult> {
    if (this.snapshot.runtime === 'running' || this.snapshot.runtime === 'starting') {
      return { ok: true }
    }
    this.updateSnapshot({ runtime: 'starting', runtimeError: null, connection: 'connecting' })

    const resolution = this.envDetectorFactory().resolve()
    if (resolution.uvPath === null) {
      return this.failStart(
        `uv not found (${resolution.notes.map((n) => n).join('; ')})`,
      )
    }
    if (this.cwd === undefined || this.cwd === '') {
      return this.failStart('plugin cwd unavailable')
    }

    const spec: CommandSpec = {
      command: resolution.uvPath,
      args: ['run', '--directory', this.cwd, 'anywhere-cli', 'start'],
      env: buildConnectorEnv(this.snapshot.environment),
      cwd: this.cwd,
    }

    const started = this.runner.start(spec)
    if (!started) return this.failStart('connector subprocess refused to start')

    // Hook RPC after stdio streams are open.
    const transport = runnerToTransport(this.runner)
    this.client = new RpcClient(transport)
    this.client.on('notification', (method, params) => this.handleNotification(method, params))
    this.client.on('error', (error) => this.handleRpcError(error))

    try {
      const remote = await this.client.send<ConnectorStateSnapshot>('connector.getState', undefined)
      this.snapshot = { ...remote, logBufferSize: this.logs.length }
    } catch (error) {
      await this.runner.stop()
      this.client?.close()
      this.client = null
      return this.failStart(`rpc handshake failed: ${errorMessage(error)}`)
    }

    this.updateSnapshot({ runtime: 'running', connection: 'connected' })
    return { ok: true }
  }

  async stop(): Promise<OperationResult> {
    if (this.snapshot.runtime === 'stopped') return { ok: true }
    // `stopping` is a transient intermediate; we don't model it in the public
    // ConnectorRuntimeState union, so we mark the runner intent via the
    // internal runner state and let the runner's exit event flip the
    // ConnectorState to `stopped` cleanly.
    if (this.client !== null) {
      try {
        await this.client.send('connector.stop', undefined)
      } catch {
        // Ignore — the subprocess may already be down.
      }
      this.client.close()
      this.client = null
    }
    await this.runner.stop()
    this.updateSnapshot({ runtime: 'stopped', connection: 'disconnected' })
    return { ok: true }
  }

  async restart(): Promise<OperationResult> {
    await this.stop()
    return this.start()
  }

  async startPairing(serverUrl?: string): Promise<PairingStartResult> {
    if (serverUrl !== undefined && serverUrl.length > 0) {
      this.updateSnapshot({ pairing: { ...this.snapshot.pairing, serverUrl } })
    }
    if (this.client === null) {
      return { ok: false, error: 'connector is not running' }
    }
    try {
      return await this.client.send<PairingStartResult>('connector.startPairing', { serverUrl: this.snapshot.pairing.serverUrl })
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  async cancelPairing(): Promise<OperationResult> {
    if (this.client === null) return { ok: false, error: 'connector is not running' }
    try {
      await this.client.send('connector.cancelPairing', undefined)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  async clearCredentials(): Promise<OperationResult> {
    if (this.client === null) {
      this.updateSnapshot({ device: null, pairing: { ...INITIAL_PAIRING, serverUrl: this.snapshot.pairing.serverUrl } })
      return { ok: true }
    }
    try {
      await this.client.send('connector.clearCredentials', undefined)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  async detectEnvironment(): Promise<EnvironmentInfo> {
    return { ...this.snapshot.environment }
  }

  async saveEnvironment(patch: Partial<EnvironmentInfo>): Promise<OperationResult> {
    const next: EnvironmentInfo = { ...this.snapshot.environment, ...patch }
    this.updateSnapshot({ environment: next })
    return { ok: true }
  }

  async getLogs(options?: { offset?: number; limit?: number; level?: string }): Promise<ConnectorLogChunk> {
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 100
    const level = options?.level
    const filtered = level === undefined
      ? this.logs
      : this.logs.filter((entry) => entry.level === level)
    return {
      entries: filtered.slice(offset, offset + limit).map((entry) => ({ ...entry })),
      total: filtered.length,
    }
  }

  async clearLogs(): Promise<OperationResult> {
    this.logs.length = 0
    this.emit('state', this.getSnapshot())
    return { ok: true }
  }

  async openConfigDirectory(): Promise<OperationResult> {
    return { ok: true }
  }

  /** Tear everything down; idempotent. */
  async dispose(): Promise<void> {
    if (this.teardownInFlight) return
    this.teardownInFlight = true
    this.client?.close()
    this.client = null
    await this.runner.dispose()
    this.removeAllListeners()
    this.teardownInFlight = false
  }

  private handleRunnerState(state: string): void {
    switch (state) {
        case 'running':
          this.updateSnapshot({ runtime: 'running' })
          break
        case 'crashed': {
          this.updateSnapshot({ runtime: 'error', connection: 'disconnected' })
          break
        }
        case 'stopped':
          if (this.snapshot.runtime !== 'stopped' && this.snapshot.runtime !== 'starting') {
            this.updateSnapshot({ runtime: 'stopped', connection: 'disconnected' })
          }
          break
        case 'starting':
          this.updateSnapshot({ runtime: 'starting' })
          break
      }
  }

  private handleRunnerLog(entry: ConnectorLogEvent): void {
    const log: ConnectorLog = {
      id: entry.id,
      time: entry.time,
      level: entry.level,
      logger: entry.logger,
      message: entry.message,
    }
    this.logs.push(log)
    if (this.logs.length > LOG_BUFFER_LIMIT) {
      this.logs.splice(0, this.logs.length - LOG_BUFFER_LIMIT)
    }
    this.emit('log', log)
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'connector/state': {
        if (isStateSnapshot(params)) {
          this.snapshot = { ...params, logBufferSize: this.logs.length }
          this.emit('state', this.getSnapshot())
        }
        return
      }
      case 'connector/pairing': {
        if (isPairingState(params)) {
          this.updateSnapshot({ pairing: params })
        }
        return
      }
      case 'connector/log': {
        if (isConnectorLog(params)) {
          this.handleRunnerLog({
            id: params.id,
            time: params.time,
            level: params.level,
            logger: params.logger,
            message: params.message,
          })
        }
        return
      }
      default:
        return
    }
  }

  private handleRpcError(error: Error): void {
    this.snapshot = { ...this.snapshot, runtimeError: error.message }
    this.emit('state', this.getSnapshot())
  }

  private failStart(message: string): OperationResult {
    this.updateSnapshot({ runtime: 'error', connection: 'disconnected', runtimeError: message })
    return { ok: false, error: message }
  }

  private updateSnapshot(patch: Partial<ConnectorStateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, logBufferSize: this.logs.length }
    this.emit('state', this.getSnapshot())
  }
}

function initialSnapshot(): ConnectorStateSnapshot {
  return {
    version: 1,
    runtime: 'stopped',
    runtimeError: null,
    connection: 'disconnected',
    bridge: null,
    device: null,
    pairing: { ...INITIAL_PAIRING },
    environment: { ...INITIAL_ENVIRONMENT },
    dataDir: '~/.agents-anywhere',
    logBufferSize: 0,
  }
}

function buildConnectorEnv(env: EnvironmentInfo): Record<string, string> {
  return {
    AA_SERVER_URL: env.pypiMirror,
    AA_DATA_DIR: '~/.agents-anywhere',
    AA_PYPI_MIRROR: env.pypiMirror,
    AA_AUTO_START: env.autoStart ? '1' : '0',
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- Runtime guards for `unknown` payloads -------------------------------

function isStateSnapshot(value: unknown): value is ConnectorStateSnapshot {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.runtime === 'string'
    && typeof candidate.connection === 'string'
    && typeof candidate.pairing === 'object'
    && typeof candidate.environment === 'object'
  )
}

function isPairingState(value: unknown): value is PairingState {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.status === 'string'
}

function isConnectorLog(value: unknown): value is ConnectorLog {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string'
    && typeof candidate.message === 'string'
    && typeof candidate.level === 'string'
}

export type { UvResolutionResult }
export { EnvDetector } from './env-detector.js'
// Re-export so the Cordis-side service can instantiate the default detector.
export const defaultEnvDetectorFactory = (): EnvDetector => new EnvDetector()