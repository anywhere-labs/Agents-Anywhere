import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Mesh, MeshCallError, Router } from 'meshcall'
import type { ResolvedConfig } from '../config.js'
import type { BoundDevice } from '../account/binding.js'
import { writeJson } from '../storage/files.js'
import { DEFAULT_CONNECTOR_SETTINGS, type ConnectorSettings } from '../../contracts/connector.js'
import type { RuntimeLogPage, RuntimeLogQuery } from '../../contracts/logs.js'
import { ControlServiceClient, type ConnectorState as ControlState } from '../generated/connector-control.js'
import { LogsServiceClient } from '../generated/connector-logs.js'
import { RuntimeDiagnostics, RuntimeRpcLogger } from '../dsh-runtime/diagnostics.js'
import { RpcLogOutput } from '../dsh-runtime/log-output.js'
import { readRuntimeLogPage } from '../dsh-runtime/log-reader.js'
import { resolveUv } from './environment.js'
import { ConnectorLogs } from './logs.js'
import { materializeConnectorProject } from './project.js'

function deriveLogsPath(value: { logsPath?: unknown; runtimePath?: unknown }): string | null {
  if (typeof value.logsPath === 'string' && value.logsPath) return value.logsPath
  if (typeof value.runtimePath === 'string' && value.runtimePath) return join(dirname(value.runtimePath), 'logs')
  return null
}

const runFile = promisify(execFile)
/** The ready line (`connector.ready`) is a few hundred bytes; anything larger is a protocol error. */
const MAX_READY_BYTES = 64 * 1024
/** The Router is already serving when it writes the ready line; a wedged handshake must not hang startup. */
const CONTROL_CONNECT_TIMEOUT_MS = 10_000
/**
 * The first request waits out uv's initial dependency installation, not a Python launch: the
 * Connector project pulls roughly 235 MiB of wheels, which needs a quarter of an hour on a
 * 300 KB/s link. A stalled install still fails long before this budget, because uv gives up on
 * its own read timeout below and its exit rejects every pending request; the caller may abort
 * the start signal at any point. So this only bounds an installation that is making progress.
 */
const FIRST_REQUEST_TIMEOUT = 3_600_000
/** Bounds a transfer that stopped producing bytes, which uv can see and this process cannot. */
const UV_READ_TIMEOUT_SECONDS = '60'
/** Reclaiming the cache is housekeeping, so it may not outlast the failure that asked for it. */
const CACHE_PRUNE_TIMEOUT = 60_000
type ConnectorLauncher = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams
type CachePruner = (command: string) => Promise<unknown>

/**
 * uv unpacks a download into a temporary directory inside its cache and only commits the entry
 * once it is whole, so a child killed mid-download orphans that directory for good: the reporter
 * of #112 accumulated 57 of them, 2.44 GiB, over four days of retries. Pruning drops exactly those
 * dangling entries and keeps every archive that did finish, so the next attempt still starts from
 * whatever the last one managed to download.
 */
const pruneUvCache: CachePruner = command => runFile(command, ['cache', 'prune'], { timeout: CACHE_PRUNE_TIMEOUT, windowsHide: true })

/** What `anywhere-cli rpc` writes on stdout once its Router serves the control channel. */
interface Rendezvous {
  kind: 'connector.ready'
  version: 1
  instanceId: string
  pid: number
  endpoint: { unixPath: string } | { pipe: string }
  key: string
}

function parseRendezvous(line: string): Rendezvous | undefined {
  let value: Record<string, unknown>
  try { value = JSON.parse(line) as Record<string, unknown> } catch { return undefined }
  const endpoint = value.endpoint && typeof value.endpoint === 'object' ? value.endpoint as Record<string, unknown> : {}
  const local = typeof endpoint.unixPath === 'string' ? { unixPath: endpoint.unixPath }
    : typeof endpoint.pipe === 'string' ? { pipe: endpoint.pipe } : undefined
  if (value.kind !== 'connector.ready' || value.version !== 1 || !local || !Number.isSafeInteger(value.pid)
    || typeof value.instanceId !== 'string' || typeof value.key !== 'string' || !value.key.startsWith('mk_')) return undefined
  return { kind: 'connector.ready', version: 1, instanceId: value.instanceId, pid: value.pid as number, endpoint: local, key: value.key }
}

export interface ConnectorProcess {
  readonly running: boolean
  readonly lastError?: string | null
  readonly logsPath?: string | null
  onState(listener: (state: ConnectorState) => void): () => void
  prepare(settings?: ConnectorSettings): Promise<void>
  start(binding: BoundDevice, apiBaseUrl: string, signal: AbortSignal): Promise<void>
  stop(): Promise<void>
  assertHealthy(): Promise<void>
  hasRuntimeLogs?(): boolean
  resolveLogsPath?(): Promise<string | null>
  readRuntimeLogs?(query?: RuntimeLogQuery): Promise<RuntimeLogPage>
}

export interface ConnectorState { running: boolean; authFailed: boolean; logsPath?: string | null }
export class ConnectorCredentialError extends Error {
  constructor() { super('本机设备连接已失效，请在插件中恢复连接。') }
}

export class ConnectorOwnershipError extends Error {
  readonly code = 'connector_already_running'
  constructor() { super('当前已有其他 Connector 在运行，请先结束对应的 Connector 进程，然后重试。') }
}

/** The Router's application error for a lost ownership race becomes the onboarding signal. */
function connectorFailure(error: unknown): unknown {
  return error instanceof MeshCallError && error.code === 'connector_already_running'
    ? new ConnectorOwnershipError()
    : error
}

/** Owns only the child it spawns; DSH Agent operations are served by the plugin runtime. */
export class SourceConnector implements ConnectorProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private mesh: Mesh | null = null
  private control: ControlServiceClient | null = null
  private logsClient: LogsServiceClient | null = null
  private cachedLogsPath: string | null = null
  private readyBuffer = ''
  private ready: Rendezvous | null = null
  private readyWaiter: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null
  private events: AbortController | null = null
  private failure: Error | null = null
  private stopping: Promise<void> | null = null
  private state: ConnectorState = { running: false, authFailed: false }
  private listeners = new Set<(state: ConnectorState) => void>()
  private readonly closed = new WeakSet<ChildProcessWithoutNullStreams>()
  private readonly logs: ConnectorLogs
  private readonly logOutput: RpcLogOutput
  private readonly diagnostics: RuntimeDiagnostics
  /** 可写的项目副本；uv 只在这个目录里写 uv.lock，绝不碰插件包目录。 */
  private projectDir: string | null = null
  constructor(
    private readonly config: ResolvedConfig,
    private readonly launch: ConnectorLauncher = spawn,
    private readonly settings: () => ConnectorSettings = () => DEFAULT_CONNECTOR_SETTINGS,
    private readonly firstRequestTimeoutMs = FIRST_REQUEST_TIMEOUT,
    private readonly prune: CachePruner = pruneUvCache,
    diagnostics?: RuntimeDiagnostics,
    logOutput?: RpcLogOutput,
  ) {
    this.logs = new ConnectorLogs(join(config.stateRoot, 'logs'))
    this.logOutput = logOutput ?? new RpcLogOutput(512, 'plugin')
    this.diagnostics = diagnostics ?? new RuntimeDiagnostics(this.logOutput, {}, 'dsh-plugin')
  }

  private get alive(): boolean { return this.child !== null && this.child.exitCode === null && this.child.signalCode === null }
  get running(): boolean { return this.alive && this.state.running && !this.state.authFailed }
  get lastError(): string | null { return this.failure?.message ?? null }
  get logsPath(): string | null { return this.cachedLogsPath }
  hasRuntimeLogs(): boolean { return this.logsClient !== null }
  onState(listener: (state: ConnectorState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async resolveLogsPath(): Promise<string | null> {
    if (this.cachedLogsPath) return this.cachedLogsPath
    if (!this.control) return null
    try {
      const paths = await this.control.getPaths({ timeoutMs: 3_000 })
      const resolved = deriveLogsPath(paths as { logsPath?: unknown; runtimePath?: unknown })
      if (resolved) {
        this.cachedLogsPath = resolved
      }
    } catch {
      /* Control channel may be closing or still handshaking. */
    }
    return this.cachedLogsPath
  }

  async readRuntimeLogs(query?: RuntimeLogQuery): Promise<RuntimeLogPage> {
    const client = this.logsClient
    if (!client) {
      return {
        available: false,
        items: [],
        firstSeq: null,
        lastSeq: null,
        total: 0,
        hasMoreBefore: false,
        hasMoreAfter: false,
        logsPath: this.cachedLogsPath,
        updatedAt: new Date().toISOString(),
      }
    }
    await this.logOutput.flush()
    return readRuntimeLogPage(client, query, this.cachedLogsPath)
  }

  private updateState(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const state = value as Partial<ControlState> & { logsPath?: unknown }
    const resolvedLogsPath = deriveLogsPath(state)
    if (resolvedLogsPath) {
      this.cachedLogsPath = resolvedLogsPath
    }
    if (typeof state.running !== 'boolean' || typeof state.authFailed !== 'boolean') return
    if (state.running === this.state.running && state.authFailed === this.state.authFailed) return
    // Do not forward config paths, credentials or raw error text from Python.
    this.state = { running: state.running, authFailed: state.authFailed }
    this.logs.record(state.authFailed ? 'auth_failed' : state.running ? 'running' : 'stopped')
    this.diagnostics.log(state.authFailed ? 'warn' : 'info', 'connector.state_changed', {
      running: state.running,
      authFailed: state.authFailed,
    })
    for (const listener of this.listeners) listener({ ...this.state })
  }

  async prepare(settings = this.settings()): Promise<void> {
    // uv 会在项目目录写 uv.lock，所以插件包目录只当只读负载用，项目落到可写副本里。
    this.projectDir = await materializeConnectorProject(this.config)
    try {
      const executable = await resolveUv(this.config, settings)
      if (!executable) throw new Error('uv unavailable')
      await runFile(executable, ['--version'], { timeout: 10_000, windowsHide: true })
    } catch {
      throw new Error('未找到可用的 uv，请安装 uv，或在插件配置中指定 uvPath。')
    }
  }

  async start(binding: BoundDevice, apiBaseUrl: string, signal: AbortSignal): Promise<void> {
    if (this.stopping) await this.stopping
    if (this.running) return
    if (this.alive) await this.stop()
    signal.throwIfAborted()
    const dataDir = join(this.config.stateRoot, 'connector')
    const configPath = join(dataDir, 'connector.json')
    const settings = this.settings()
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    await writeJson(configPath, {
      serverUrl: apiBaseUrl,
      connectorId: binding.connectorId,
      connectorToken: binding.connectorToken,
      statePath: join(dataDir, `${binding.connectorId}.sqlite3`),
      heartbeatSeconds: 20,
      reconnectSeconds: 3,
      syncIntervalSeconds: settings.syncIntervalSeconds,
      syncExistingOnConnect: true,
    })
    signal.throwIfAborted()
    this.failure = null
    this.readyBuffer = ''
    this.ready = null
    this.updateState({ running: false, authFailed: false })
    await this.logs.startSession([binding.connectorToken])
    this.logs.record('starting')
    this.diagnostics.log('info', 'connector.starting', { connectorId: binding.connectorId, apiBaseUrl })
    const executable = await resolveUv(this.config, settings)
    const command = executable ?? (settings.uvPath || this.config.uvPath)
    const pypiIndexUrl = settings.uvPypiIndexUrl || 'https://pypi.org/simple'
    signal.throwIfAborted()
    // 不依赖 prepare() 的调用顺序：start() 自己也要保证项目副本就位。
    const projectDir = this.projectDir ??= await materializeConnectorProject(this.config)
    signal.throwIfAborted()
    const child = this.launch(command, [
      'run', '--directory', projectDir,
      'anywhere-cli', 'rpc', '--config', configPath,
    ], {
      cwd: projectDir,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        AA_CONNECTOR_OWNER_KIND: 'dsh-plugin',
        ...(this.config.dshHome ? { DSH_HOME: this.config.dshHome } : {}),
        AGENT_CONNECTOR_DATA_DIR: dataDir,
        UV_PROJECT_ENVIRONMENT: join(this.config.stateRoot, 'connector-venv'),
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUNBUFFERED: '1',
        UV_HTTP_TIMEOUT: process.env['UV_HTTP_TIMEOUT'] || UV_READ_TIMEOUT_SECONDS,
        UV_PYTHON_INSTALL_MIRROR: settings.uvPythonInstallMirror || 'https://github.com/astral-sh/python-build-standalone/releases/download',
        UV_DEFAULT_INDEX: pypiIndexUrl,
        UV_INDEX_URL: pypiIndexUrl,
        PIP_INDEX_URL: pypiIndexUrl,
      },
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { if (this.child === child) this.receive(chunk) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.logs.output(chunk) })
    child.stdin.on('error', () => { if (this.child === child) this.fail(new Error('Connector 输入连接已关闭。')) })
    child.on('error', () => { if (this.child === child) this.fail(new Error('Connector 进程启动失败，请检查 uv 和源码运行环境。')) })
    child.on('close', (code) => {
      this.closed.add(child)
      this.logs.finish()
      this.logs.record(`exited (${code ?? 'signal'})`)
      this.diagnostics.log(this.stopping ? 'info' : 'warn', 'connector.exited', { exitCode: code ?? 'signal' })
      void this.logs.flush().catch(() => undefined)
      if (this.child === child) {
        this.child = null
        void this.releaseControl()
        this.fail(new Error(`Connector 已退出（${code ?? '终止'}）。请在日志页切换到 Connector 查看原因。`), !this.stopping)
      }
    })
    const abort = () => { void this.stop() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      // Includes the first uv dependency installation, not just Python startup.
      await this.connect(signal)
      const control = this.control!
      this.updateState(await control.getState({ timeoutMs: this.firstRequestTimeoutMs }))
      signal.throwIfAborted()
      this.updateState(await control.start(undefined, { timeoutMs: this.firstRequestTimeoutMs }))
      signal.throwIfAborted()
      this.watchEvents()
    } catch (error) {
      await this.stop()
      // Whatever ended this attempt left a partial download behind, and only a prune reclaims it.
      try { await this.prune(command) } catch { /* Housekeeping may not replace the real failure. */ }
      throw connectorFailure(error)
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  async assertHealthy(): Promise<void> {
    if (this.state.authFailed) throw new ConnectorCredentialError()
    if (this.failure) throw this.failure
    const state = await this.requireControl().getState({ timeoutMs: 15_000 })
    this.updateState(state)
    if (state.authFailed) throw new ConnectorCredentialError()
    if (!state.running) throw new Error('Connector 尚未运行，请返回插件重试。')
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.stopChild().finally(async () => { await this.logs.flush(); this.failure = null; this.stopping = null })
    return this.stopping
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    this.events?.abort()
    this.events = null
    if (!child) { await this.releaseControl(); return }
    try { await this.logOutput.flush() } catch { /* Best effort before child stop. */ }
    try { await this.control?.stop({ timeoutMs: 3_000 }) } catch { /* Child may not have finished starting. */ }
    child.stdin.end()
    const ended = new Promise<void>((resolve) => {
      if (this.closed.has(child) || child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('close', () => resolve())
    })
    // Closing stdio lets the Python controller shut down its owned runtime.
    await Promise.race([ended, delay(1_000)])
    if (!this.closed.has(child)) await this.terminate(child, false)
    await Promise.race([ended, delay(3_000)])
    if (!this.closed.has(child)) await this.terminate(child, true)
    await ended
    if (this.child === child) this.child = null
    await this.releaseControl()
  }

  /** Close the Mesh a crashed Connector left behind; its reconnect loop never ends on its own. */
  private async releaseControl(): Promise<void> {
    const mesh = this.mesh
    this.mesh = null
    this.control = null
    this.logsClient = null
    this.logOutput.connect(undefined)
    await mesh?.close().catch(() => undefined)
  }

  private async terminate(child: ChildProcessWithoutNullStreams, force: boolean): Promise<void> {
    if (!child.pid) return
    if (process.platform === 'win32') {
      if (force) { try { await runFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }) } catch { /* Already exited. */ } }
      else child.kill()
    } else {
      try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch { /* Owned process group already exited. */ }
    }
  }

  private requireControl(): ControlServiceClient {
    if (!this.control) throw this.failure ?? new Error('Connector 未启动。')
    return this.control
  }

  /** Wait for the ready line, then connect to the Connector's Router. */
  private async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null
        reject(new Error('Connector 响应超时，请检查 Python 依赖安装和网络连接。'))
      }, this.firstRequestTimeoutMs)
      this.readyWaiter = { resolve, reject, timer }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      if (this.ready) { this.readyWaiter = null; clearTimeout(timer); resolve() }
    })
    const ready = this.ready!
    const router = new Router(ready.endpoint)
    const rpcLogger = new RuntimeRpcLogger(this.diagnostics)
    const mesh = new Mesh(router, { token: ready.key, peerId: `dsh-plugin-${ready.instanceId}`, logger: rpcLogger })
    const connecting = mesh.connect()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        connecting,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Connector 控制通道连接超时。')), CONTROL_CONNECT_TIMEOUT_MS)
          timer.unref()
        }),
      ])
    } catch (error) {
      // The losing connect promise may still reject later; handle it here so it
      // is not reported as unhandled, and close the half-open mesh.
      connecting.catch(() => undefined)
      await mesh.close().catch(() => undefined)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (signal.aborted) {
      await mesh.close().catch(() => undefined)
      throw signal.reason instanceof Error ? signal.reason : new Error('Connector 启动已取消。')
    }
    this.mesh = mesh
    this.control = new ControlServiceClient(mesh)
    this.logsClient = new LogsServiceClient(mesh)
    this.logOutput.connect(this.logsClient)
    this.diagnostics.log('info', 'connector.control_connected', { instanceId: ready.instanceId, pid: ready.pid })
    void this.logOutput.flush()
  }

  /** Follow state changes; a dropped stream resumes after the last seq. */
  private watchEvents(): void {
    const controller = new AbortController()
    this.events = controller
    const run = async () => {
      let since: number | null = null
      let backoff = 500
      while (!controller.signal.aborted) {
        try {
          const stream = this.requireControl().events(since, { signal: controller.signal })
          for await (const event of stream) {
            since = event.seq
            if (event.kind === 'state' && event.state) this.updateState(event.state)
            backoff = 500
          }
          if (!controller.signal.aborted) throw new Error('Connector 事件流已结束。')
        } catch (error) {
          if (controller.signal.aborted || this.stopping) return
          if (error instanceof MeshCallError && error.code === 'connector_error') return
          await delay(backoff)
          backoff = Math.min(backoff * 2, 5_000)
        }
      }
    }
    void run()
  }

  private receive(chunk: string): void {
    if (this.ready) return
    this.readyBuffer += chunk
    if (this.readyBuffer.length > MAX_READY_BYTES) { this.fail(new Error('Connector 返回了过大的消息。')); return }
    const newline = this.readyBuffer.indexOf('\n')
    if (newline < 0) return
    const line = this.readyBuffer.slice(0, newline)
    this.readyBuffer = this.readyBuffer.slice(newline + 1)
    const ready = parseRendezvous(line)
    if (!ready) { this.fail(new Error('Connector 返回了无效的启动消息。')); return }
    this.ready = ready
    const waiter = this.readyWaiter
    this.readyWaiter = null
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve() }
    if (this.readyBuffer.trim()) this.fail(new Error('Connector 在启动后仍向 stdout 写入了数据。'))
  }

  private fail(error: Error, report = true): void {
    this.failure = error
    if (report) {
      this.logs.record('process_error')
      this.diagnostics.log('error', 'connector.process_failed', {}, error)
    }
    this.updateState({ ...this.state, running: false })
    const waiter = this.readyWaiter
    this.readyWaiter = null
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(error) }
  }
}
