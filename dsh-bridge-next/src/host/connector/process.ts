import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { ResolvedConfig } from '../config.js'
import type { BoundDevice } from '../account/binding.js'
import { writeJson } from '../storage/files.js'
import { DEFAULT_CONNECTOR_SETTINGS, type ConnectorSettings } from '../../contracts/connector.js'
import { resolveUv } from './environment.js'
import { ConnectorLogs } from './logs.js'

const runFile = promisify(execFile)
const MAX_FRAME = 1024 * 1024
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
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ConnectorProcess {
  readonly running: boolean
  readonly lastError?: string | null
  onState(listener: (state: ConnectorState) => void): () => void
  prepare(settings?: ConnectorSettings): Promise<void>
  start(binding: BoundDevice, apiBaseUrl: string, signal: AbortSignal): Promise<void>
  stop(): Promise<void>
  assertHealthy(): Promise<void>
}

export interface ConnectorState { running: boolean; authFailed: boolean }
export class ConnectorCredentialError extends Error {
  constructor() { super('本机设备连接已失效，请在插件中恢复连接。') }
}

export class ConnectorOwnershipError extends Error {
  readonly code = -32009
  constructor() { super('当前已有其他 Connector 在运行，请先结束对应的 Connector 进程，然后重试。') }
}

/** Owns only the child it spawns; DSH Agent operations are served by the plugin runtime. */
export class SourceConnector implements ConnectorProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 0
  private pending = new Map<number, Pending>()
  private buffer = ''
  private failure: Error | null = null
  private stopping: Promise<void> | null = null
  private state: ConnectorState = { running: false, authFailed: false }
  private listeners = new Set<(state: ConnectorState) => void>()
  private readonly closed = new WeakSet<ChildProcessWithoutNullStreams>()
  private readonly logs: ConnectorLogs
  constructor(private readonly config: ResolvedConfig, private readonly launch: ConnectorLauncher = spawn,
    private readonly settings: () => ConnectorSettings = () => DEFAULT_CONNECTOR_SETTINGS,
    private readonly firstRequestTimeoutMs = FIRST_REQUEST_TIMEOUT,
    private readonly prune: CachePruner = pruneUvCache) {
    this.logs = new ConnectorLogs(join(config.stateRoot, 'logs'))
  }

  private get alive(): boolean { return this.child !== null && this.child.exitCode === null && this.child.signalCode === null }
  get running(): boolean { return this.alive && this.state.running && !this.state.authFailed }
  get lastError(): string | null { return this.failure?.message ?? null }
  onState(listener: (state: ConnectorState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private updateState(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const state = value as Partial<ConnectorState>
    if (typeof state.running !== 'boolean' || typeof state.authFailed !== 'boolean') return
    if (state.running === this.state.running && state.authFailed === this.state.authFailed) return
    // Do not forward config paths, credentials or raw error text from Python.
    this.state = { running: state.running, authFailed: state.authFailed }
    this.logs.record(state.authFailed ? 'auth_failed' : state.running ? 'running' : 'stopped')
    for (const listener of this.listeners) listener({ ...this.state })
  }

  async prepare(settings = this.settings()): Promise<void> {
    try {
      await access(join(this.config.connectorSourceDir, 'pyproject.toml'))
      await access(join(this.config.connectorSourceDir, 'connector', 'cli.py'))
    } catch {
      throw new Error('未找到内部 Connector 源码，请重新构建插件或配置 connectorSourceDir。')
    }
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
    this.buffer = ''
    this.updateState({ running: false, authFailed: false })
    await this.logs.startSession([binding.connectorToken])
    this.logs.record('starting')
    const executable = await resolveUv(this.config, settings)
    const command = executable ?? (settings.uvPath || this.config.uvPath)
    const pypiIndexUrl = settings.uvPypiIndexUrl || 'https://pypi.org/simple'
    signal.throwIfAborted()
    const child = this.launch(command, [
      'run', '--directory', this.config.connectorSourceDir,
      'anywhere-cli', 'rpc', '--config', configPath,
    ], {
      cwd: this.config.connectorSourceDir,
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
      void this.logs.flush().catch(() => undefined)
      if (this.child === child) {
        this.child = null
        this.fail(new Error(`Connector 已退出（${code ?? '终止'}）。请在日志页切换到 Connector 查看原因。`), !this.stopping)
      }
    })
    const abort = () => { void this.stop() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      // Includes the first uv dependency installation, not just Python startup.
      this.updateState(await this.call('connector.getState', this.firstRequestTimeoutMs))
      signal.throwIfAborted()
      this.updateState(await this.call('connector.start'))
      signal.throwIfAborted()
    } catch (error) {
      await this.stop()
      // Whatever ended this attempt left a partial download behind, and only a prune reclaims it.
      try { await this.prune(command) } catch { /* Housekeeping may not replace the real failure. */ }
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  async assertHealthy(): Promise<void> {
    if (this.state.authFailed) throw new ConnectorCredentialError()
    if (this.failure) throw this.failure
    const state = await this.call('connector.getState') as ConnectorState
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
    if (!child) return
    try { await this.call('connector.stop', 3_000) } catch { /* Child may not have finished starting. */ }
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

  private call(method: string, timeoutMs = 15_000): Promise<unknown> {
    if (!this.child || this.failure) return Promise.reject(this.failure ?? new Error('Connector 未启动。'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Connector 响应超时，请检查 Python 依赖安装和网络连接。'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method })}\n`)
    })
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_FRAME) { this.fail(new Error('Connector 返回了过大的消息。')); return }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      try {
        const frame = JSON.parse(line) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
        if (frame.method === 'connector/state' && frame.id === undefined) { this.updateState(frame.params); continue }
        if (typeof frame.id !== 'number') continue
        const pending = this.pending.get(frame.id)
        if (!pending) continue
        this.pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.error) {
          const error = frame.error as { code?: number; data?: { reason?: string } }
          pending.reject(error.code === -32009 && error.data?.reason === 'connector_already_running'
            ? new ConnectorOwnershipError() : new Error('Connector 操作失败，请检查本机运行环境后重试。'))
        }
        else pending.resolve(frame.result)
      } catch { this.fail(new Error('Connector 返回了无效的协议消息。')) }
    }
  }

  private fail(error: Error, report = true): void {
    this.failure = error
    if (report) this.logs.record('process_error')
    this.updateState({ ...this.state, running: false })
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
}
