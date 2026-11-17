// ported from effi-evo cloud/agentd/src/conv/agent-process.ts @95b52ec (process lifecycle)
//
// One ACP adapter child process: spawn, stderr tail, exit reason, stop on demand. The ACP protocol part lives in
// runtime/acp/client.ts. On POSIX the process leads its own process group (stopping it also ends the app-server /
// Claude CLI the adapter launched); on Windows taskkill /T ends the process tree (Job objects await the S3
// distribution decision).

import { spawn, type ChildProcess } from 'node:child_process'

import { DEFAULT_MAX_MESSAGE_BYTES, JsonRpcPeer, ndjsonTransport } from '../acp/jsonrpc.js'

export interface AgentCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

export interface SpawnOptions {
  readonly maxMessageBytes?: number
  /** Every stderr line (debug logs). */
  readonly onStderr?: (line: string) => void
  /** How long after SIGTERM to send SIGKILL. */
  readonly killAfterMs?: number
}

export class AgentProcess {
  readonly peer: JsonRpcPeer
  readonly startedAt = Date.now()
  private readonly child: ChildProcess
  private stderrTail = ''
  private exitedReason: string | undefined
  private readonly exitPromise: Promise<string>
  /** Stopping as planned: a later exit does not count as a crash. */
  private stopping = false
  private readonly killAfterMs: number

  constructor(readonly spec: AgentCommand, options: SpawnOptions = {}) {
    this.killAfterMs = options.killAfterMs ?? 3000
    this.child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-4000)
      if (options.onStderr) for (const line of text.split('\n')) if (line.trim() !== '') options.onStderr(line)
    })
    let resolveExit!: (why: string) => void
    this.exitPromise = new Promise(resolve => (resolveExit = resolve))
    const markExited = (why: string): void => {
      if (this.exitedReason !== undefined) return
      this.exitedReason = why
      resolveExit(why)
    }
    this.child.on('error', error => markExited(`failed to start ${spec.command}: ${error.message}`))
    this.child.on('exit', (code, signal) => {
      const tail = this.stderrTail.trim()
      markExited(`agent process exited (${signal !== null ? `signal ${signal}` : `code ${String(code)}`})` +
        (tail !== '' ? `: ${tail.split('\n').slice(-3).join(' / ').slice(0, 500)}` : ''))
    })
    this.peer = new JsonRpcPeer(ndjsonTransport(this.child.stdout!, this.child.stdin!, options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES))
    // Pipe errors (such as EPIPE when writing as the Agent exits) only close this Runtime connection and must not become uncaught exceptions in the Connector process.
    for (const [name, stream] of [['stdin', this.child.stdin], ['stdout', this.child.stdout]] as const) {
      stream?.on('error', (error: Error) => {
        if (!this.peer.isClosed) this.peer.close(`agent ${name} failed: ${error.message}`)
      })
    }
    this.child.stderr?.on('error', (error: Error) => {
      this.stderrTail = (this.stderrTail + `\nstderr failed: ${error.message}`).slice(-4000)
    })
    // The connection dropped but the process lives on (limit exceeded, garbage on stdout): nobody can talk to it anymore, so treat it as a crash.
    void this.peer.whenClosed().then(reason => {
      if (this.exitedReason !== undefined || this.stopping) return
      setTimeout(() => {
        if (this.exitedReason !== undefined) return
        this.stderrTail += `\nACP connection broke: ${reason}`
        this.kill('SIGKILL')
      }, 1000).unref()
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get alive(): boolean {
    return this.exitedReason === undefined
  }

  /** Whether it stopped as planned (not a crash). */
  get expectedExit(): boolean {
    return this.stopping
  }

  get exitReason(): string | undefined {
    return this.exitedReason
  }

  get stderr(): string {
    return this.stderrTail
  }

  /** Resolves (with the reason) when the process exits. */
  exited(): Promise<string> {
    return this.exitPromise
  }

  /**
   * Rejects with the exit reason when the process exits first, so requests never hang forever.
   */
  async withExit<T>(promise: Promise<T>): Promise<T> {
    const exited = this.exitPromise.then(why => {
      throw new Error(why)
    })
    exited.catch(() => undefined)
    try {
      return await Promise.race([promise, exited])
    } catch (error) {
      if (this.exitedReason !== undefined) throw new Error(this.exitedReason)
      // The streams may close slightly before the exit event.
      const why = await Promise.race([this.exitPromise, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1000).unref())])
      if (why !== undefined) throw new Error(why)
      throw error
    }
  }

  /** Stops: closes stdin, SIGTERMs the process group, SIGKILLs on timeout; waits until the process really exits (by then things like its write locks are released). */
  async stop(): Promise<void> {
    if (this.exitedReason !== undefined) return
    this.stopping = true
    this.peer.close('stopping')
    this.kill('SIGTERM')
    const timer = setTimeout(() => this.kill('SIGKILL'), this.killAfterMs)
    timer.unref()
    await Promise.race([this.exitPromise, new Promise(resolve => setTimeout(resolve, this.killAfterMs + 2000).unref())])
    clearTimeout(timer)
  }

  private kill(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (pid === undefined || this.exitedReason !== undefined) return
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore' })
      } else {
        process.kill(-pid, signal)
      }
    } catch {
      try {
        this.child.kill(signal)
      } catch {
        // already exited
      }
    }
  }
}
