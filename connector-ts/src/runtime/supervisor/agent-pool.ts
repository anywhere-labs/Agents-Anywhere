// ported from effi-evo cloud/agentd/src/conv/agent-pool.ts @95b52ec (AgentPool)
//
// One (shared) ACP adapter process per Runtime instance: started on first need and shared by all sessions; stopped
// when the instance stops or after staying idle too long. A crash ends the running turns of all sessions; the process
// restarts on next need. Consecutive crashes back off, so a broken adapter is not restarted in a loop.
// Pools are keyed by instance ID; the process factory is injectable (tests use in-memory connections); the caller
// decides what counts as busy.

/** A connection the pool manages (a real process or a test double). */
export interface PooledConnection {
  readonly startedAt: number
  readonly alive: boolean
  /** Stopped as planned (not a crash). */
  readonly expectedExit: boolean
  readonly pid?: number | undefined
  exited(): Promise<string>
  stop(): Promise<void>
}

/** Default: a process with no turn, pending interaction or background task is stopped after being idle this long. */
export const DEFAULT_IDLE_MS = 30 * 60_000
/** A process no session uses (started only to list sessions or probe models) stops sooner. */
const UNUSED_IDLE_MS = 60_000
/** After running stably this long before a crash, the crash count starts over. */
const STABLE_MS = 60_000
/** Wait after the n-th consecutive crash (n >= 2): 2 seconds, 4 seconds... up to one minute. The first restart happens at once. */
const BACKOFF_BASE_MS = 2000
const BACKOFF_MAX_MS = 60_000

export function backoffMs(failures: number): number {
  return failures <= 1 ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 2))
}

export interface PoolOptions<T extends PooledConnection> {
  readonly start: () => Promise<T>
  /** A turn, interaction or background task is in progress: not idle. */
  readonly busy: (connection: T) => boolean
  /** A session is using it. */
  readonly attached: (connection: T) => boolean
  readonly lastActivity: (connection: T) => number
  readonly idleMs?: number
  /** The process exited (including crashes); expected means a planned stop. */
  readonly onExit?: (connection: T, reason: string, expected: boolean) => void
  readonly now?: () => number
}

export interface PoolState {
  readonly running: boolean
  readonly error?: string
  /** Next allowed start time during backoff (ISO). */
  readonly retryAt?: string
  readonly failures: number
}

export class AgentPool<T extends PooledConnection> {
  private current: T | undefined
  private starting: Promise<T> | undefined
  /** The process that is exiting: the next one waits for it to exit (only then are things like its write locks released). */
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

  /** The live connection, if any. */
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

  /** Gets the connection, starting one if there is none (concurrent calls get the same one). */
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

  /** Stops the current process (restart, instance shutdown); planned, so no backoff. Returns whether a process was running. */
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

  /** Stops the process after it has been idle too long (no turn, interaction or background task). */
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
