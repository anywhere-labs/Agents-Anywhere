import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { ResolvedConfig } from '../config.js'
import type { Binding } from '../account/binding.js'
import { writeJson } from '../storage/files.js'

const runFile = promisify(execFile)
const MAX_FRAME = 1024 * 1024
type ConnectorLauncher = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ConnectorProcess {
  readonly running: boolean
  prepare(): Promise<void>
  start(binding: Required<Binding>, apiBaseUrl: string, signal: AbortSignal): Promise<void>
  stop(): Promise<void>
  assertHealthy(): Promise<void>
}

/** Owns only the child it spawns; DSH Agent operations are served by the plugin runtime. */
export class SourceConnector implements ConnectorProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 0
  private pending = new Map<number, Pending>()
  private buffer = ''
  private failure: Error | null = null
  private stopping: Promise<void> | null = null
  private readonly closed = new WeakSet<ChildProcessWithoutNullStreams>()
  constructor(private readonly config: ResolvedConfig, private readonly launch: ConnectorLauncher = spawn) {}

  get running(): boolean { return this.child !== null && this.child.exitCode === null && this.child.signalCode === null }

  async prepare(): Promise<void> {
    try {
      await access(join(this.config.connectorSourceDir, 'pyproject.toml'))
      await access(join(this.config.connectorSourceDir, 'connector', 'cli.py'))
    } catch {
      throw new Error('未找到内部 Connector 源码，请重新构建插件或配置 connectorSourceDir。')
    }
    try {
      await runFile(this.config.uvPath, ['--version'], { timeout: 10_000, windowsHide: true })
    } catch {
      throw new Error('未找到可用的 uv，请安装 uv，或在插件配置中指定 uvPath。')
    }
  }

  async start(binding: Required<Binding>, apiBaseUrl: string, signal: AbortSignal): Promise<void> {
    if (this.stopping) await this.stopping
    if (this.running) return
    signal.throwIfAborted()
    const dataDir = join(this.config.stateRoot, 'connector')
    const configPath = join(dataDir, 'connector.json')
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    await writeJson(configPath, {
      serverUrl: apiBaseUrl,
      connectorId: binding.connectorId,
      connectorToken: binding.connectorToken,
      statePath: join(dataDir, `${binding.connectorId}.sqlite3`),
    })
    signal.throwIfAborted()
    this.failure = null
    this.buffer = ''
    const child = this.launch(this.config.uvPath, [
      'run', '--directory', this.config.connectorSourceDir,
      'anywhere-cli', 'rpc', '--config', configPath,
    ], {
      cwd: this.config.connectorSourceDir,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...(this.config.dshHome ? { DSH_HOME: this.config.dshHome } : {}),
        AGENT_CONNECTOR_DATA_DIR: dataDir,
        UV_PROJECT_ENVIRONMENT: join(this.config.stateRoot, 'connector-venv'),
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUNBUFFERED: '1',
      },
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.receive(chunk))
    // Always drain stderr (uv may install dependencies); raw subprocess output
    // can contain credentials, so it is never forwarded to the browser/logs.
    child.stderr.resume()
    child.stdin.on('error', () => this.fail(new Error('Connector 输入连接已关闭。')))
    child.on('error', () => this.fail(new Error('Connector 进程启动失败，请检查 uv 和源码运行环境。')))
    child.on('close', (code) => {
      this.closed.add(child)
      if (this.child === child) this.child = null
      this.fail(new Error(`Connector 已退出（${code ?? '终止'}）。请检查运行环境后重试。`))
    })
    const abort = () => { void this.stop() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      // Includes the first uv dependency installation, not just Python startup.
      await this.call('connector.getState', 180_000)
      signal.throwIfAborted()
      await this.call('connector.start')
      signal.throwIfAborted()
    } catch (error) {
      await this.stop()
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  async assertHealthy(): Promise<void> {
    if (this.failure) throw this.failure
    const state = await this.call('connector.getState') as { running?: boolean; authFailed?: boolean }
    if (state.authFailed) throw new Error('设备凭据已失效，请退出登录后重新连接。')
    if (!state.running) throw new Error('Connector 尚未运行，请返回插件重试。')
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.stopChild().finally(() => { this.stopping = null })
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
        const frame = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
        if (typeof frame.id !== 'number') continue
        const pending = this.pending.get(frame.id)
        if (!pending) continue
        this.pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.error) pending.reject(new Error('Connector 操作失败，请检查本机运行环境后重试。'))
        else pending.resolve(frame.result)
      } catch { this.fail(new Error('Connector 返回了无效的协议消息。')) }
    }
  }

  private fail(error: Error): void {
    this.failure = error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
}
