// ported from effi-evo cloud/agentd/src/conv/agent-process.ts @95b52ec（进程部分；effi-crew @30f8334 的同名文件是它的早期版本）
//
// 一个 ACP 适配器子进程：spawn、stderr 末尾、退出原因、按需停止。ACP 协议部分在 runtime/acp/client.ts。
// 与 agentd 的差别：POSIX 上自成进程组（停止时连同适配器拉起的 app-server / Claude CLI 一起结束）；
// Windows 上用 taskkill /T 结束进程树（Job 对象留待 S3 的分发结论）。

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
  /** stderr 每一行（调试日志）。 */
  readonly onStderr?: (line: string) => void
  /** SIGTERM 之后多久 SIGKILL。 */
  readonly killAfterMs?: number
}

export class AgentProcess {
  readonly peer: JsonRpcPeer
  readonly startedAt = Date.now()
  private readonly child: ChildProcess
  private stderrTail = ''
  private exitedReason: string | undefined
  private readonly exitPromise: Promise<string>
  /** 正在按计划停止：之后的退出不算崩溃。 */
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
    // 连接断了但进程还在（超限、stdout 上的垃圾）：没人还能和它说话，按崩溃处理。
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

  /** 是否是按计划停止的（不是崩溃）。 */
  get expectedExit(): boolean {
    return this.stopping
  }

  get exitReason(): string | undefined {
    return this.exitedReason
  }

  get stderr(): string {
    return this.stderrTail
  }

  /** 进程退出时 resolve（原因）。 */
  exited(): Promise<string> {
    return this.exitPromise
  }

  /**
   * 进程先退出时以退出原因 reject，避免请求永远挂着。
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
      // 流可能比 exit 事件早关一点。
      const why = await Promise.race([this.exitPromise, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1000).unref())])
      if (why !== undefined) throw new Error(why)
      throw error
    }
  }

  /** 停止：关 stdin，SIGTERM 进程组，超时 SIGKILL；等到进程真正退出（它持有的写锁之类此时已释放）。 */
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
        // 已经退出
      }
    }
  }
}
