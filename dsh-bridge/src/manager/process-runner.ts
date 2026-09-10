/**
 * Lifecycle daemon for the `Agents Anywhere Connector` child process.
 *
 * The runner owns ONE subprocess at a time:
 *
 *   - `start(spec)` spawns the command (typically `uv run connector rpc`) and
 *     starts emitting `log` events from its captured stdio.
 *   - `stop()` sends SIGTERM, waits up to `gracefulStopMs` for the process to
 *     exit, then escalates to SIGKILL.
 *   - `restart()` is a convenience wrapper.
 *
 * Cross-platform lifecycle handling:
 *   - POSIX: spawn with `detached: true` so the child becomes its own process
 *     group leader; killing the group via `-pid` avoids orphans.
 *   - Windows: spawn with `detached: true` and `windowsHide: true`; kill via
 *     `taskkill /pid <pid> /t /f` so the child tree is reaped.
 *
 * The runner is intentionally minimal: it does not own the JSON-RPC protocol,
 * the log ring buffer, or any backoff state machine — those are layered on
 * top by `RpcClient` and `AgentState` callers.
 */

import { ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import process from 'node:process'

export type ConnectorLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ConnectorLogEvent {
  readonly id: string
  readonly time: number
  readonly level: ConnectorLogLevel
  readonly logger: string
  readonly message: string
}

export interface CommandSpec {
  /** Executable to spawn (typically an absolute path to `uv`). */
  readonly command: string
  /** Argument list passed to the executable. */
  readonly args: ReadonlyArray<string>
  /** Environment overrides layered on top of `process.env`. */
  readonly env?: Record<string, string>
  /** Working directory of the child; defaults to `process.cwd()`. */
  readonly cwd?: string
  /** How long `stop()` waits for a graceful exit before SIGKILL. */
  readonly gracefulStopMs?: number
}

export type RunnerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'

export interface RunnerEvents {
  state: (state: RunnerState, detail?: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  log: (entry: ConnectorLogEvent) => void
  error: (error: Error) => void
}

export declare interface ProcessRunner {
  on<K extends keyof RunnerEvents>(event: K, listener: RunnerEvents[K]): this
  off<K extends keyof RunnerEvents>(event: K, listener: RunnerEvents[K]): this
  emit<K extends keyof RunnerEvents>(event: K, ...args: Parameters<RunnerEvents[K]>): boolean
}

const DEFAULT_GRACEFUL_STOP_MS = 5_000
const STARTUP_TIMEOUT_MS = 30_000

export class ProcessRunner extends EventEmitter {
  private current: ChildProcess | null = null
  private state: RunnerState = 'stopped'
  private stderrBuffer = ''
  private stderrDrainScheduled = false
  private readonly gracefulStopMs: number

  constructor(options: { gracefulStopMs?: number } = {}) {
    super()
    this.gracefulStopMs = options.gracefulStopMs ?? DEFAULT_GRACEFUL_STOP_MS
  }

  /** One-word state for the UI. */
  getState(): RunnerState {
    return this.state
  }

  /** The PID of the live child process, or `null`. */
  getPid(): number | null {
    return this.current?.pid ?? null
  }

  /** Spawn the configured command. Returns false if already running. */
  start(spec: CommandSpec): boolean {
    if (this.state === 'starting' || this.state === 'running') return false
    this.setState('starting')

    const env: NodeJS.ProcessEnv = { ...process.env, ...(spec.env ?? {}) }
    const cwd = spec.cwd ?? process.cwd()

    let child: ChildProcess
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd,
        env,
        // stdin MUST be a pipe: the JSON-RPC client writes request frames
        // to it. `ignore` would silently drop every send, causing the
        // handshake to time out with "rpc client: stdin unavailable".
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (error: unknown) {
      this.setState('crashed')
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
      return false
    }

    this.current = child
    this.stderrBuffer = ''

    // stdout carries the JSON-RPC protocol stream and is consumed exclusively
    // by `RpcClient` (via `runnerToTransport`). We must NOT treat it as logs:
    // Python's pairing poll re-emits `connector/state` on every tick, and
    // surfacing each one through the log pipeline floods the host event loop.
    // Drain it here only to avoid backpressure; stderr is the only log source.
    child.stdout?.setEncoding('utf8')
    child.stdout?.resume()
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.handleStreamChunk('stderr', chunk))

    child.on('error', (error) => {
      this.emit('error', error)
    })

    child.on('exit', (code, signal) => {
      this.flushBuffers()
      this.current = null
      if (this.state === 'stopping') {
        this.state = 'stopped'
        this.emit('state', 'stopped', { exitCode: code, signal })
      } else {
        this.state = 'crashed'
        this.emit('state', 'crashed', { exitCode: code, signal })
      }
    })

    this.setState('running')
    return true
  }

  /** Stop the child with SIGTERM → SIGKILL escalation. Resolves when exited. */
  async stop(): Promise<void> {
    const child = this.current
    if (child === null) {
      this.setState('stopped')
      return
    }
    this.setState('stopping')

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      child.once('exit', finish)
      try {
        sendTerminate(child)
      } catch (error: unknown) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)))
        finish()
      }
      setTimeout(() => {
        if (settled) return
        try {
          sendKill(child)
        } catch (error: unknown) {
          this.emit('error', error instanceof Error ? error : new Error(String(error)))
        }
      }, this.gracefulStopMs)
    })

    this.current = null
    this.setState('stopped')
  }

  /** Convenience: stop (if running) and start fresh with the same spec. */
  async restart(spec: CommandSpec): Promise<boolean> {
    await this.stop()
    return this.start(spec)
  }

  /** Stop + drop references. Safe to call multiple times. */
  async dispose(): Promise<void> {
    await this.stop()
    this.removeAllListeners()
  }

  private handleStreamChunk(stream: 'stdout' | 'stderr', chunk: string): void {
    // stderr is the only log source (stdout is drained by RpcClient). Append
    // and drain asynchronously so a flood of stderr lines — uv printing install
    // progress on first launch — cannot starve the event loop and freeze the UI.
    if (stream === 'stderr') {
      this.stderrBuffer += chunk
      this.scheduleStderrDrain()
    }
  }

  private scheduleStderrDrain(): void {
    if (this.stderrDrainScheduled) return
    this.stderrDrainScheduled = true
    setImmediate(() => {
      this.stderrDrainScheduled = false
      this.drainStderrBuffer()
    })
  }

  private drainStderrBuffer(): void {
    let newlineIndex = this.stderrBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).replace(/\r$/, '')
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1)
      if (line.length > 0) this.emitLog('stderr', line)
      newlineIndex = this.stderrBuffer.indexOf('\n')
    }
  }

  private flushBuffers(): void {
    // Drain any complete lines first, then flush the trailing partial line.
    this.drainStderrBuffer()
    if (this.stderrBuffer.length > 0) {
      this.emitLog('stderr', this.stderrBuffer)
      this.stderrBuffer = ''
    }
  }

  private emitLog(stream: 'stdout' | 'stderr', line: string): void {
    const clean = stripAnsi(line)
    if (clean.trim().length === 0) return
    this.emit('log', {
      id: randomUUID(),
      time: Date.now(),
      level: stream === 'stderr' ? classifyStderrLevel(clean) : 'info',
      logger: 'connector',
      message: clean,
    })
  }

  private setState(next: RunnerState): void {
    if (this.state === next) return
    this.state = next
    this.emit('state', next)
  }
}

/** Strip ANSI escape sequences and carriage returns from a stderr line. */
function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')
}

/** Heuristically grade a stderr line: uv streams install progress to stderr,
 *  which is informational, not an error. */
function classifyStderrLevel(line: string): ConnectorLogLevel {
  if (/(?:^|\b)(error|traceback|exception|critical|fatal|failed|no such file|not found)(?:\b|:)/i.test(line)) return 'error'
  if (/(?:^|\b)(warn(?:ing)?|deprecat(?:ed|ion))(?:\b|:)/i.test(line)) return 'warn'
  return 'info'
}

function sendTerminate(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return
  if (process.platform === 'win32') {
    // On Windows, `child.kill('SIGTERM')` translates to `TerminateProcess`,
    // which works for tree reaping via /T below. We still escalate to taskkill
    // /F after the graceful window expires.
    child.kill('SIGTERM')
    return
  }
  try {
    // Send to the whole process group so children-of-children don't outlive
    // the connector CLI. The runner spawned with `detached: true`, so the
    // child's pid is also the pgid.
    process.kill(-(child.pid ?? 0), 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

function sendKill(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-(child.pid ?? 0), 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

// Re-export the STARTUP_TIMEOUT_MS constant so `RpcClient.start()` can use
// the same number without redeclaring it.
export const CONNECTOR_STARTUP_TIMEOUT_MS = STARTUP_TIMEOUT_MS