// ported from effi-evo cloud/agentd/src/conv/agent-pool.ts @95b52ec（effi-crew @30f8334 没有这个文件）
//
// 每个 Runtime 实例一个（共享）ACP 适配器进程：第一次需要时启动，所有会话共用；停止实例、空闲太久时停掉。
// 崩溃会结束所有会话正在跑的回合；下一次需要时重新启动。连续崩溃退避，坏掉的适配器不会被循环重启。
// 与 agentd 的差别：键是实例 ID；进程工厂可注入（测试用内存连接）；忙碌判定由调用方提供。

/** 池管理的一个连接（真实进程或测试替身）。 */
export interface PooledConnection {
  readonly startedAt: number
  readonly alive: boolean
  /** 按计划停止的（不算崩溃）。 */
  readonly expectedExit: boolean
  readonly pid?: number | undefined
  exited(): Promise<string>
  stop(): Promise<void>
}

/** 默认：没有回合、待答交互或后台任务的进程，空闲这么久就停掉。 */
export const DEFAULT_IDLE_MS = 30 * 60_000
/** 没有会话在用的进程（只为列会话或探测模型启动的）早点停。 */
const UNUSED_IDLE_MS = 60_000
/** 崩溃前稳定运行了这么久，崩溃计数重新开始。 */
const STABLE_MS = 60_000
/** 第 n 次连续崩溃（n ≥ 2）后的等待：2 秒、4 秒……最多一分钟。第一次重启立即进行。 */
const BACKOFF_BASE_MS = 2000
const BACKOFF_MAX_MS = 60_000

export function backoffMs(failures: number): number {
  return failures <= 1 ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 2))
}

export interface PoolOptions<T extends PooledConnection> {
  readonly start: () => Promise<T>
  /** 有回合、交互或后台任务在进行：不算空闲。 */
  readonly busy: (connection: T) => boolean
  /** 有会话在用。 */
  readonly attached: (connection: T) => boolean
  readonly lastActivity: (connection: T) => number
  readonly idleMs?: number
  /** 进程退出（含崩溃）；expected 表示按计划停止。 */
  readonly onExit?: (connection: T, reason: string, expected: boolean) => void
  readonly now?: () => number
}

export interface PoolState {
  readonly running: boolean
  readonly error?: string
  /** 退避期间的下次允许启动时间（ISO）。 */
  readonly retryAt?: string
  readonly failures: number
}

export class AgentPool<T extends PooledConnection> {
  private current: T | undefined
  private starting: Promise<T> | undefined
  /** 正在退出的进程：下一个要等它退出（它持有的写锁之类那时才释放）。 */
  private stopping: Promise<void> | undefined
  private failures = 0
  private retryAt = 0
  private lastError: string | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  private readonly idleMs: number
  private readonly now: () => number

  constructor(private readonly options: PoolOptions<T>) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.now = options.now ?? Date.now
  }

  /** 活着的连接，如果有。 */
  live(): T | undefined {
    return this.current?.alive === true ? this.current : undefined
  }

  state(): PoolState {
    const running = this.live() !== undefined
    const backingOff = this.retryAt > this.now()
    const recent = this.failures > 0 && (!running || this.now() - (this.current?.startedAt ?? 0) < STABLE_MS)
    return {
      running,
      failures: this.failures,
      ...(this.lastError !== undefined && (backingOff || recent) ? { error: this.lastError } : {}),
      ...(backingOff ? { retryAt: new Date(this.retryAt).toISOString() } : {}),
    }
  }

  /** 拿到连接，没有就启动（同时来的调用拿到同一个）。 */
  acquire(): Promise<T> {
    if (this.closed) return Promise.reject(new Error('runtime is stopping'))
    const live = this.live()
    if (live) return Promise.resolve(live)
    if (this.starting) return this.starting
    const wait = this.retryAt - this.now()
    if (wait > 0) {
      return Promise.reject(new Error(`the ACP process exited ${this.failures} times in a row; retrying in ${Math.ceil(wait / 1000)} s` +
        (this.lastError !== undefined ? ` (last: ${this.lastError})` : '')))
    }
    const started = this.startOne().finally(() => {
      if (this.starting === started) this.starting = undefined
    })
    this.starting = started
    return started
  }

  private async startOne(): Promise<T> {
    await this.stopping
    let connection: T
    try {
      connection = await this.options.start()
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error))
      throw error
    }
    if (this.closed) {
      await connection.stop()
      throw new Error('runtime is stopping')
    }
    this.current = connection
    void connection.exited().then(reason => this.exited(connection, reason))
    this.watchIdle()
    return connection
  }

  private failed(reason: string): void {
    this.failures += 1
    this.lastError = reason
    this.retryAt = this.now() + backoffMs(this.failures)
  }

  private exited(connection: T, reason: string): void {
    if (this.current === connection) this.current = undefined
    if (!connection.expectedExit) {
      if (this.now() - connection.startedAt >= STABLE_MS) this.failures = 0
      this.failed(reason)
    }
    this.options.onExit?.(connection, reason, connection.expectedExit)
  }

  /** 停掉当前进程（重启、关闭实例）；计划内，不退避。返回是否有进程在跑。 */
  async stop(): Promise<boolean> {
    if (this.starting) await this.starting.catch(() => undefined)
    const connection = this.current
    this.current = undefined
    this.failures = 0
    this.retryAt = 0
    this.lastError = undefined
    if (!connection || !connection.alive) {
      await this.stopping
      return false
    }
    await this.stopConnection(connection)
    return true
  }

  private stopConnection(connection: T): Promise<void> {
    const stopped = connection.stop().finally(() => {
      if (this.stopping === stopped) this.stopping = undefined
    })
    this.stopping = stopped
    return stopped
  }

  private watchIdle(): void {
    if (this.idleMs <= 0 || this.timer !== undefined) return
    this.timer = setInterval(() => this.checkIdle(), Math.max(50, Math.min(60_000, Math.floor(this.idleMs / 4))))
    this.timer.unref?.()
  }

  /** 空闲太久就停掉（没有回合、交互、后台任务）。 */
  checkIdle(now = this.now()): void {
    const connection = this.current
    if (!connection || !connection.alive || this.starting) return
    const limit = this.options.attached(connection) ? this.idleMs : Math.min(UNUSED_IDLE_MS, this.idleMs)
    if (this.options.busy(connection) || now - this.options.lastActivity(connection) < limit) return
    this.current = undefined
    void this.stopConnection(connection)
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    const connection = this.current
    this.current = undefined
    if (connection) await connection.stop()
    await this.stopping
  }
}
