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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  type AppDownloadQrInfo,
  type BridgeInfo,
  type ConnectorCredentials,
  type ConnectorHostApi,
  type ConnectorLog,
  type ConnectorLogChunk,
  type ConnectorStateSnapshot,
  type DeviceBinding,
  type EnvironmentInfo,
  INITIAL_ENVIRONMENT,
  INITIAL_OAUTH,
  INITIAL_PAIRING,
  type MobileLoginQrData,
  type MobileLoginStatusInfo,
  type OperationResult,
  type PairingStartResult,
  type PairingState,
  type UserAccount,
} from '../common/types.js'
import { EnvDetector, type UvResolutionResult } from './env-detector.js'
import { OAuthClient, saveStableDeviceId } from './oauth-client.js'
import { ProcessRunner, type CommandSpec, type ConnectorLogEvent } from './process-runner.js'
import { RpcClient, runnerToTransport } from './rpc-client.js'

export interface CoordinatorOptions {
  /** Optional factory for tests to inject a deterministic EnvDetector. */
  envDetectorFactory?: () => EnvDetector
  /** Optional OAuthClient instance. */
  oauthClient?: OAuthClient
  /** Working directory for the spawned CLI subprocess. */
  cwd?: string
  /** Subprocess graceful-stop deadline; forwarded to the runner. */
  gracefulStopMs?: number
  /** Absolute path to the connector credential JSON (`connector.json`). */
  configPath?: string
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
  private readonly oauthClient: OAuthClient
  private client: RpcClient | null = null
  private snapshot: ConnectorStateSnapshot
  private readonly logs: ConnectorLog[] = []
  private envDetectorFactory: () => EnvDetector
  private readonly cwd: string
  private readonly configPath: string
  private readonly accountPath: string
  private teardownInFlight = false
  private currentUserToken: string | null = null

  constructor(options: CoordinatorOptions = {}) {
    super()
    this.runner = new ProcessRunner(
      options.gracefulStopMs === undefined
        ? {}
        : { gracefulStopMs: options.gracefulStopMs },
    )
    this.oauthClient = options.oauthClient ?? new OAuthClient()
    this.envDetectorFactory = options.envDetectorFactory ?? (() => new EnvDetector())
    this.cwd = options.cwd ?? process.cwd()
    this.configPath = options.configPath ?? path.join(os.homedir(), '.agents-anywhere', 'connector.json')
    this.accountPath = path.join(path.dirname(this.configPath), 'account.json')
    const { account, userToken } = this.loadPersistedAccount()
    this.currentUserToken = userToken
    this.snapshot = initialSnapshot(account)
    this.runner.on('state', (state) => this.handleRunnerState(state))
    this.runner.on('log', (entry) => this.handleRunnerLog(entry))
    this.runner.on('error', (error) => {
      this.snapshot = { ...this.snapshot, runtimeError: error.message }
      this.emit('state', this.snapshot)
    })
  }

  private loadPersistedAccount(): { account: UserAccount | null; userToken: string | null } {
    const candidatePaths = [
      path.join(os.homedir(), '.dsh', 'agents-anywhere', 'account.json'),
      this.accountPath,
    ]
    for (const p of candidatePaths) {
      try {
        if (existsSync(p)) {
          const raw = readFileSync(p, 'utf-8')
          const data = JSON.parse(raw) as Partial<UserAccount> & { userToken?: string }
          if (data && typeof data.userId === 'string' && typeof data.serverUrl === 'string') {
            const account: UserAccount = {
              userId: data.userId,
              ...(data.role !== undefined ? { role: data.role } : {}),
              avatar: data.avatar ?? null,
              serverUrl: data.serverUrl,
              loggedInAt: data.loggedInAt || Date.now(),
            }
            return { account, userToken: data.userToken ?? null }
          }
        }
      } catch {
        // Ignore corrupt state
      }
    }
    return { account: null, userToken: null }
  }

  private savePersistedAccount(account: UserAccount, userToken?: string): void {
    const targetPaths = [
      path.join(os.homedir(), '.dsh', 'agents-anywhere', 'account.json'),
      this.accountPath,
    ]
    const content = JSON.stringify({ ...account, userToken: userToken ?? this.currentUserToken }, null, 2)
    for (const p of targetPaths) {
      try {
        const dir = path.dirname(p)
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
        writeFileSync(p, content, 'utf-8')
      } catch {
        // Ignore write errors
      }
    }
  }

  private clearPersistedAccount(): void {
    const targetPaths = [
      path.join(os.homedir(), '.dsh', 'agents-anywhere', 'account.json'),
      this.accountPath,
    ]
    for (const p of targetPaths) {
      try {
        if (existsSync(p)) {
          unlinkSync(p)
        }
      } catch {
        // Ignore
      }
    }
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
    // While the subprocess is still starting (e.g. uv installing dependencies
    // on first launch), the RPC handshake would hang and block the UI poll.
    // Return the local snapshot immediately so the UI keeps rendering the
    // "initializing" state until the handshake completes.
    if (this.client !== null && this.snapshot.runtime !== 'starting') {
      try {
        const remote = await this.client.send<unknown>('connector.getState')
        if (isPythonState(remote)) {
          this.snapshot = {
            ...this.snapshot,
            ...mapRuntimeFromPython(remote, this.configPath, this.snapshot.device),
            account: this.snapshot.account,
            oauth: this.snapshot.oauth,
            logBufferSize: this.logs.length,
          }
        }
      } catch {
        // Fall through to the local snapshot.
      }
    }
    return this.getSnapshot()
  }

  async start(): Promise<OperationResult> {
    const ensured = await this.ensureRpcProcess()
    if (!ensured.ok) return ensured
    const client = this.client
    if (client === null) return this.failStart('connector rpc is unavailable')
    if (!existsSync(this.configPath)) {
      return { ok: false, error: 'no connector credentials configured' }
    }
    try {
      await client.send('connector.start', undefined)
      this.updateSnapshot({ runtime: 'running', connection: 'connected' })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  /**
   * Ensure the `anywhere-cli rpc` control plane is running and handshaken.
   * Spawns it on first use and leaves an already-running process untouched.
   * The `rpc` subcommand serves the JSON-RPC control API over stdio (the
   * `start` subcommand does not — it only runs the connector daemon directly).
   */
  private async ensureRpcProcess(): Promise<OperationResult> {
    if (this.client !== null) return { ok: true }
    if (this.snapshot.runtime === 'starting') return { ok: true }
    this.updateSnapshot({ runtime: 'starting', runtimeError: null, connection: 'connecting' })

    const resolution = this.envDetectorFactory().resolve()
    if (resolution.uvPath === null) {
      return this.failStart(`uv not found (${resolution.notes.join('; ')})`)
    }
    if (this.cwd === undefined || this.cwd === '') {
      return this.failStart('plugin cwd unavailable')
    }

    const spec: CommandSpec = {
      command: resolution.uvPath,
      args: ['run', '--directory', this.cwd, 'anywhere-cli', 'rpc', '--config', this.configPath],
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
      const remote = await this.client.send<unknown>('connector.getState', undefined)
      if (isPythonState(remote)) {
        this.snapshot = { ...this.snapshot, ...mapRuntimeFromPython(remote), logBufferSize: this.logs.length }
      }
    } catch (error) {
      // The RPC transport may have died before the handshake completed. Wait
      // a short moment for late stderr lines to flush through the runner,
      // then tear down and report the cause with whatever stderr tail we can
      // surface so the UI message is not just "rpc client closed".
      await new Promise<void>((resolve) => {
        const wait = setTimeout(resolve, 300)
        const stopWait = (): void => { clearTimeout(wait); resolve() }
        const handler = (): void => stopWait()
        this.runner.once('state', handler)
        stopWait()
      })
      await this.runner.stop()
      this.client?.close()
      this.client = null
      const stderrTail = this.logs.filter((entry) => entry.level === 'error').slice(-3).map((entry) => entry.message).join(' | ')
      const detail = stderrTail.length > 0 ? `${errorMessage(error)} (stderr: ${stderrTail})` : errorMessage(error)
      return this.failStart(`rpc handshake failed: ${detail}`)
    }

    return { ok: true }
  }

  async stop(): Promise<OperationResult> {
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

  // ─── OAuth2 & Account ───────────────────────────────────────────────────

  async startOAuthLogin(serverUrl?: string): Promise<OperationResult> {
    const targetUrl = serverUrl !== undefined && serverUrl.length > 0 ? serverUrl : this.snapshot.oauth.serverUrl
    this.updateSnapshot({
      oauth: { status: 'opening_browser', serverUrl: targetUrl, lastError: null },
      pairing: { ...this.snapshot.pairing, serverUrl: targetUrl },
    })

    try {
      this.updateSnapshot({
        oauth: { status: 'waiting_callback', serverUrl: targetUrl, lastError: null },
      })
      const result = await this.oauthClient.startLoginFlow(targetUrl)
      if (!result.ok || !result.credentials || !result.account) {
        const err = result.error ?? 'OAuth authorization failed'
        this.updateSnapshot({ oauth: { status: 'error', serverUrl: targetUrl, lastError: err } })
        return { ok: false, error: err }
      }

      this.currentUserToken = result.userToken ?? null
      this.savePersistedAccount(result.account, result.userToken)
      this.updateSnapshot({
        account: result.account,
        oauth: { status: 'registering_device', serverUrl: targetUrl, lastError: null },
      })

      const saveRes = await this.saveCredentials(result.credentials)
      if (!saveRes.ok) {
        const err = saveRes.error ?? 'failed to save credentials'
        this.updateSnapshot({ oauth: { status: 'error', serverUrl: targetUrl, lastError: err } })
        return saveRes
      }

      this.updateSnapshot({
        oauth: { status: 'success', serverUrl: targetUrl, lastError: null },
      })
      return { ok: true }
    } catch (error) {
      const err = errorMessage(error)
      this.updateSnapshot({ oauth: { status: 'error', serverUrl: targetUrl, lastError: err } })
      return { ok: false, error: err }
    }
  }

  async cancelOAuthLogin(): Promise<OperationResult> {
    this.oauthClient.cancel()
    this.updateSnapshot({
      oauth: { status: 'cancelled', serverUrl: this.snapshot.oauth.serverUrl, lastError: null },
    })
    return { ok: true }
  }

  async createMobileLoginQr(): Promise<MobileLoginQrData | null> {
    if (!this.currentUserToken || !this.snapshot.account) {
      return null
    }
    try {
      return await this.oauthClient.createMobileLoginQr(this.snapshot.account.serverUrl, this.currentUserToken)
    } catch (error) {
      return null
    }
  }

  async getMobileLoginStatus(loginToken: string): Promise<MobileLoginStatusInfo | null> {
    if (!this.currentUserToken || !this.snapshot.account) {
      return null
    }
    try {
      return await this.oauthClient.getMobileLoginStatus(this.snapshot.account.serverUrl, this.currentUserToken, loginToken)
    } catch (error) {
      return null
    }
  }

  async confirmMobileLogin(loginToken: string, approved: boolean): Promise<MobileLoginStatusInfo | null> {
    if (!this.currentUserToken || !this.snapshot.account) {
      return null
    }
    try {
      return await this.oauthClient.confirmMobileLogin(this.snapshot.account.serverUrl, this.currentUserToken, loginToken, approved)
    } catch (error) {
      return null
    }
  }

  async getAppDownloadQr(serverUrl?: string): Promise<AppDownloadQrInfo | null> {
    const targetUrl = serverUrl || this.snapshot.account?.serverUrl || this.snapshot.oauth.serverUrl
    try {
      return await this.oauthClient.getAppDownloadQr(targetUrl)
    } catch (error) {
      return null
    }
  }

  async logout(): Promise<OperationResult> {
    this.currentUserToken = null
    this.oauthClient.cancel()
    const res = await this.clearCredentials()
    this.updateSnapshot({
      runtime: 'stopped',
      connection: 'disconnected',
      device: null,
      account: null,
      pairing: { ...INITIAL_PAIRING, serverUrl: this.snapshot.pairing.serverUrl },
      oauth: { ...INITIAL_OAUTH, serverUrl: this.snapshot.oauth.serverUrl },
    })
    return res
  }

  // ─── Legacy Pairing ─────────────────────────────────────────────────────

  async startPairing(serverUrl?: string): Promise<PairingStartResult> {
    const targetUrl = serverUrl !== undefined && serverUrl.length > 0 ? serverUrl : this.snapshot.pairing.serverUrl
    if (targetUrl.length > 0 && targetUrl !== this.snapshot.pairing.serverUrl) {
      this.updateSnapshot({ pairing: { ...this.snapshot.pairing, serverUrl: targetUrl } })
    }
    const ensured = await this.ensureRpcProcess()
    if (!ensured.ok) {
      const message = ensured.error ?? 'connector rpc unavailable'
      this.failPairing(message)
      return { ok: false, error: message }
    }
    const client = this.client
    if (client === null) {
      this.failPairing('connector rpc is unavailable')
      return { ok: false, error: 'connector rpc is unavailable' }
    }
    try {
      // The pairing code arrives asynchronously via the `connector/pairing`
      // notification; the immediate response only confirms the request.
      await client.send('connector.startPairing', { server: targetUrl })
      return { ok: true }
    } catch (error) {
      const message = errorMessage(error)
      this.failPairing(message)
      return { ok: false, error: message }
    }
  }

  /** Persist a pairing failure into the snapshot so the UI can surface it. */
  private failPairing(message: string): void {
    this.updateSnapshot({ pairing: { ...this.snapshot.pairing, status: 'error', lastError: message } })
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
    this.clearPersistedAccount()
    const targetDirs = [
      path.dirname(this.configPath),
      path.join(os.homedir(), '.dsh', 'agents-anywhere'),
      path.join(os.homedir(), '.agents-anywhere'),
    ]
    const filesToClear = [
      'connector.json',
      'connector-state.json',
      'connector-runtime.json',
      'account.json',
    ]
    for (const dir of targetDirs) {
      for (const file of filesToClear) {
        const filePath = path.join(dir, file)
        if (existsSync(filePath)) {
          try {
            unlinkSync(filePath)
          } catch {
            // ignore
          }
        }
      }
    }
    if (this.client !== null) {
      try {
        await this.client.send('connector.stop', undefined)
      } catch {
        // ignore
      }
    }
    await this.stop()
    this.updateSnapshot({
      runtime: 'stopped',
      connection: 'disconnected',
      device: null,
      account: null,
      pairing: { ...INITIAL_PAIRING, serverUrl: this.snapshot.pairing.serverUrl },
      oauth: { ...INITIAL_OAUTH, serverUrl: this.snapshot.oauth.serverUrl },
    })
    await this.ensureRpcProcess()
    return { ok: true }
  }

  async saveCredentials(credentials: ConnectorCredentials): Promise<OperationResult> {
    saveStableDeviceId(credentials.connectorId)
    const syncStatePath = path.join(path.dirname(this.configPath), 'connector-state.json')
    if (existsSync(syncStatePath)) {
      try {
        unlinkSync(syncStatePath)
      } catch {
        // ignore
      }
    }
    const ensured = await this.ensureRpcProcess()
    if (!ensured.ok) return ensured
    const client = this.client
    if (client === null) return { ok: false, error: 'connector rpc is unavailable' }
    try {
      await client.send('connector.saveConfig', {
        serverUrl: credentials.serverUrl,
        connectorId: credentials.connectorId,
        connectorToken: credentials.connectorToken,
      })
      // Reflect the saved credential as a paired device immediately.
      const hostDeviceName = os.hostname() || '本机设备'
      this.updateSnapshot({
        device: { deviceId: credentials.connectorId, deviceName: hostDeviceName, pairedAt: Date.now() },
        pairing: { ...this.snapshot.pairing, serverUrl: credentials.serverUrl, status: 'claimed', code: null },
      })
      // Use `restart` rather than `start`: a leftover connector-runtime file
      // from a previous run makes a bare `start` throw ConnectorAlreadyRunningError.
      // `restart` stops first (which clears that file) and then starts fresh.
      await client.send('connector.restart', undefined)
      this.updateSnapshot({ runtime: 'running', connection: 'connected' })
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
          this.updateSnapshot({
            runtime: 'error',
            connection: 'disconnected',
            runtimeError: this.snapshot.runtimeError ?? 'connector subprocess crashed',
          })
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
    // Deliberately do NOT call updateSnapshot here. `uv run` streams its whole
    // install progress to stderr while it first downloads + builds the venv,
    // and every one of those lines is tagged `error` by ProcessRunner. Turning
    // each line into a snapshot update floods the event loop and freezes the
    // host during that first install. Real failures surface through failStart
    // and handleRpcError instead.
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'connector/state': {
        if (isPythonState(params)) {
          // Dedup high-frequency `connector/state` notifications against the
          // current snapshot. Python's control loop fires the same payload
          // back-to-back (poll + emit_state pairs); emitting every duplicate
          // floods the snapshot diff pipeline and ties up the event loop.
          const next = mapRuntimeFromPython(params, this.configPath, this.snapshot.device)
          const previous = this.snapshot
          const unchanged =
            previous.runtime === next.runtime &&
            previous.connection === next.connection &&
            previous.runtimeError === next.runtimeError &&
            previous.device?.deviceId === next.device?.deviceId &&
            previous.device?.deviceName === next.device?.deviceName
          if (unchanged) return
          this.snapshot = {
            ...this.snapshot,
            ...next,
            account: this.snapshot.account,
            oauth: this.snapshot.oauth,
            logBufferSize: this.logs.length,
          }
          this.emit('state', this.getSnapshot())
          return
        }
        return
      }
      case 'connector/pairing': {
        if (isPythonPairing(params)) {
          this.updateSnapshot({ pairing: mapPairingFromPython(params, this.snapshot.pairing) })
        }
        return
      }
      case 'connector/log': {
        const log = mapLogFromPython(params)
        if (log !== null) {
          this.logs.push(log)
          if (this.logs.length > LOG_BUFFER_LIMIT) {
            this.logs.splice(0, this.logs.length - LOG_BUFFER_LIMIT)
          }
          this.emit('log', log)
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

function initialSnapshot(account: UserAccount | null = null): ConnectorStateSnapshot {
  return {
    version: 1,
    runtime: 'stopped',
    runtimeError: null,
    connection: 'disconnected',
    bridge: null,
    device: null,
    account,
    oauth: { ...INITIAL_OAUTH },
    pairing: { ...INITIAL_PAIRING },
    environment: { ...INITIAL_ENVIRONMENT },
    dataDir: '~/.agents-anywhere',
    logBufferSize: 0,
  }
}

function buildConnectorEnv(_env: EnvironmentInfo): Record<string, string> {
  // Keep uv's project virtualenv OUT of the source tree. Pointing uv at a
  // data-dir venv keeps the source tree clean and read-only.
  //
  // NOTE: intentionally no `UV_DEFAULT_INDEX` here. A hard-coded mirror
  // (e.g. the Tsinghua index) stalls `uv run` on networks that cannot reach
  // it, which freezes the auto-start path. uv's default index is used instead.
  const venvDir = path.join(os.homedir(), '.agents-anywhere', 'connector-venv')
  return {
    UV_PROJECT_ENVIRONMENT: venvDir,
    // Prevent Python from writing __pycache__ into the bundled source tree
    // while running `connector/*.py` — keeps the plugin directory clean and
    // the "no cached bytecode" invariant true even after a live run.
    PYTHONDONTWRITEBYTECODE: '1',
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- Runtime guards for `unknown` payloads -------------------------------

/** Loose view of the `connector.getState` response from `anywhere-cli rpc`. */
interface PythonConnectorState {
  status?: unknown
  running?: unknown
  authFailed?: unknown
  lastError?: unknown
  configPath?: unknown
  runtimePath?: unknown
  hasConfig?: unknown
}

/** Loose view of a `connector/pairing` notification payload. */
interface PythonPairingPayload {
  status?: unknown
  serverUrl?: unknown
  code?: unknown
  pairingId?: unknown
  error?: unknown
}

function isPythonState(value: unknown): value is PythonConnectorState {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.status === 'string' && typeof candidate.running === 'boolean'
}

function isPythonPairing(value: unknown): value is PythonPairingPayload {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.status === 'string'
}

/** Map the `anywhere-cli rpc` state payload onto the plugin's runtime fields. */
function mapRuntimeFromPython(
  state: PythonConnectorState,
  configPath?: string,
  prevDevice?: DeviceBinding | null,
): Partial<ConnectorStateSnapshot> {
  const running = state.running === true
  const failed = state.status === 'error' || state.status === 'expired credential'
  let device: DeviceBinding | null = null
  if (state.hasConfig === true) {
    let connectorId = prevDevice?.deviceId || 'connector'
    if (configPath && existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8')
        const parsed = JSON.parse(raw) as { connectorId?: string }
        if (parsed.connectorId) connectorId = parsed.connectorId
      } catch {
        // ignore
      }
    }
    device = {
      deviceId: connectorId,
      deviceName: prevDevice?.deviceName || os.hostname() || '本机设备',
      pairedAt: prevDevice?.pairedAt || Date.now(),
    }
  }
  return {
    runtime: running ? 'running' : failed ? 'error' : 'stopped',
    connection: running ? 'connected' : 'disconnected',
    runtimeError: typeof state.lastError === 'string' ? state.lastError : null,
    device,
  }
}

/** Map a `connector/pairing` payload onto the plugin's `PairingState`. */
function mapPairingFromPython(payload: PythonPairingPayload, prev: PairingState): PairingState {
  return {
    ...prev,
    status: mapPairingStatus(payload.status),
    code: typeof payload.code === 'string' ? payload.code : null,
    claimUrl: null,
    expiresAt: null,
    serverUrl: typeof payload.serverUrl === 'string' ? payload.serverUrl : prev.serverUrl,
    lastError: typeof payload.error === 'string' ? payload.error : null,
  }
}

function mapPairingStatus(status: unknown): PairingState['status'] {
  switch (status) {
    case 'starting':
      return 'starting'
    case 'waiting':
      return 'waiting'
    case 'claimed':
      return 'claimed'
    case 'cancelled':
      return 'cancelled'
    case 'error':
      return 'error'
    default:
      return 'cancelled'
  }
}

/**
 * Map a `connector/log` notification from `anywhere-cli rpc` into the plugin's
 * `ConnectorLog` shape. The Python loguru sink emits
 * `{ time: ISO string, level: "INFO", name, message }` — not the camelCase
 * `{ id, time: ms, level: 'info', logger }` shape the client expects, so the
 * fields are converted here instead of being forwarded verbatim.
 */
function mapLogFromPython(value: unknown): ConnectorLog | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.message !== 'string') return null

  const parsedTime = typeof candidate.time === 'string' ? Date.parse(candidate.time) : NaN
  const time = Number.isFinite(parsedTime) ? parsedTime : Date.now()
  return {
    id: randomUUID(),
    time,
    level: mapLogLevel(candidate.level),
    logger: typeof candidate.name === 'string' ? candidate.name : 'connector',
    message: candidate.message,
  }
}

function mapLogLevel(level: unknown): ConnectorLog['level'] {
  switch (typeof level === 'string' ? level.toUpperCase() : '') {
    case 'DEBUG':
      return 'debug'
    case 'WARN':
    case 'WARNING':
      return 'warn'
    case 'ERROR':
    case 'CRITICAL':
      return 'error'
    default:
      return 'info'
  }
}

export type { UvResolutionResult }
export { EnvDetector } from './env-detector.js'
// Re-export so the Cordis-side service can instantiate the default detector.
export const defaultEnvDetectorFactory = (): EnvDetector => new EnvDetector()