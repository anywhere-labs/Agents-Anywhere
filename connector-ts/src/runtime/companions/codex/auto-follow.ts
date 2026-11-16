// 自动跟随：发现 Codex App 正在使用的线程，路线为 follow 时建议会话引擎接管（`native_session.follow_suggested`）。
// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/ipc/service.py（候选扫描、有界重试、按状态退避）
//
// 候选来源是写锁目录（lock-directory.ts）：启动时扫一遍，之后目录变化或定时轮询时再扫。每个候选调
// `_codex/session/inspect`（只读，不 resume），然后：
// - route follow：建议接管，同一段持有期只建议一次（锁文件消失后再出现才会再次建议）；
// - route blocked 且锁是新出现或刚变化的：多半是「App 先广播 following、后登记 ownership」的竞态
//   （v2 docs/codex-ipc-takeover.md「接管竞态」），间隔几秒有界重试；重试用完记为 blocked，之后按较长间隔再看；
// - 其它（local 已由本进程持有、resume 无人持有）：不建议，按更长间隔再看。
// 与 v2 的差别：v2 自己是 IPC 客户端，能收到 following 广播；v3 经 codex-acp，收不到这些广播，
// 用写锁目录的变化代替。是否真的打开由会话引擎决定。

import type { CodexInspection } from './inspect.js'
import type { LockDirectory, LockEntry } from './lock-directory.js'

export interface AutoFollowOptions {
  readonly locks: LockDirectory
  readonly inspect: (threadId: string) => Promise<CodexInspection>
  /** AA 已经打开（附着）了这个线程。 */
  readonly isAttached: (threadId: string) => boolean
  readonly suggest: (threadId: string, reason: string, inspection: CodexInspection) => void
  /** 目录变化通知可能丢，定时兜底。 */
  readonly pollMs?: number
  readonly debounceMs?: number
  /** 竞态重试：间隔与次数（v2 announce_retry_delay / attempts）。 */
  readonly raceRetryDelayMs?: number
  readonly raceRetryAttempts?: number
  /** 持有但无人应答的线程多久再看一次（v2 held_retry_interval）。 */
  readonly blockedRetryMs?: number
  /** 无人持有或已由本进程持有的线程多久再看一次（v2 retry_interval）。 */
  readonly settledRetryMs?: number
  /** 每次最多看最新的多少个锁文件。 */
  readonly recentLimit?: number
  /** 同时进行的 inspect 数（没有 owner 时每个要等 IPC discovery 超时，约 5 秒）。 */
  readonly concurrency?: number
  readonly now?: () => number
}

type Status = 'suggested' | 'pending' | 'blocked' | 'settled'

interface ThreadState {
  mtimeMs: number
  status: Status
  lastProbe: number
  retries: number
}

export class CodexAutoFollow {
  private readonly threads = new Map<string, ThreadState>()
  private readonly forced = new Set<string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private stopWatch: (() => void) | undefined
  private poll: ReturnType<typeof setInterval> | undefined
  private debounce: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private again = false
  private stopped = false
  private readonly now: () => number

  constructor(private readonly options: AutoFollowOptions) {
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.stopWatch !== undefined || this.stopped) return
    this.stopWatch = this.options.locks.watch(() => this.requestScan())
    this.poll = setInterval(() => this.requestScan(), this.options.pollMs ?? 30_000)
    this.poll.unref?.()
    this.requestScan(0)
  }

  stop(): void {
    this.stopped = true
    this.stopWatch?.()
    if (this.poll !== undefined) clearInterval(this.poll)
    if (this.debounce !== undefined) clearTimeout(this.debounce)
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  /** 会话引擎关闭了线程：之后可以再次建议。 */
  forget(threadId: string): void {
    this.threads.delete(threadId)
  }

  requestScan(delayMs = this.options.debounceMs ?? 300): void {
    if (this.stopped) return
    if (this.debounce !== undefined) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      void this.scan()
    }, delayMs)
    this.debounce.unref?.()
  }

  /** 扫一遍；扫描期间又有请求时结束后再扫一遍（不丢通知）。 */
  scan(): Promise<void> {
    if (this.running !== undefined) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.scanOnce()
        } while (this.again && !this.stopped)
      } finally {
        this.running = undefined
      }
    })()
    return this.running
  }

  private async scanOnce(): Promise<void> {
    const entries = await this.options.locks.list()
    const present = new Map(entries.map(e => [e.threadId, e]))
    // 锁文件没了：这段持有结束，忘掉状态，之后再出现时重新建议。
    for (const id of [...this.threads.keys()]) if (!present.has(id) && !this.forced.has(id)) this.threads.delete(id)
    const forced = [...this.forced]
    this.forced.clear()
    const recent = entries.slice(0, this.options.recentLimit ?? 20)
    const candidates: LockEntry[] = [...forced.flatMap(id => present.get(id) ?? []), ...recent]
    const seen = new Set<string>()
    const due: { entry: LockEntry; fresh: boolean }[] = []
    for (const entry of candidates) {
      if (seen.has(entry.threadId)) continue
      seen.add(entry.threadId)
      const decision = this.due(entry, forced.includes(entry.threadId))
      if (decision !== undefined) due.push({ entry, fresh: decision })
    }
    await pool(due, this.options.concurrency ?? 4, ({ entry, fresh }) => this.probe(entry, fresh))
  }

  /** undefined：这次不看；true：新出现或刚变化（可能处在竞态里）；false：按间隔复查。 */
  private due(entry: LockEntry, forced: boolean): boolean | undefined {
    if (this.options.isAttached(entry.threadId)) return undefined
    const state = this.threads.get(entry.threadId)
    if (state === undefined || state.mtimeMs !== entry.mtimeMs) return true
    if (forced) return false
    const age = this.now() - state.lastProbe
    switch (state.status) {
      case 'suggested':
      case 'pending':
        return undefined
      case 'blocked':
        return age >= (this.options.blockedRetryMs ?? 60_000) ? false : undefined
      case 'settled':
        return age >= (this.options.settledRetryMs ?? 300_000) ? false : undefined
    }
  }

  private async probe(entry: LockEntry, fresh: boolean): Promise<void> {
    const previous = this.threads.get(entry.threadId)
    let inspection: CodexInspection | undefined
    try {
      inspection = await this.options.inspect(entry.threadId)
    } catch {
      inspection = undefined
    }
    if (this.stopped || this.options.isAttached(entry.threadId)) return
    const state: ThreadState = {
      mtimeMs: entry.mtimeMs,
      status: 'settled',
      lastProbe: this.now(),
      // 同一段持有期（锁文件未变）里累计重试次数。
      retries: previous !== undefined && previous.mtimeMs === entry.mtimeMs ? previous.retries : 0,
    }
    this.threads.set(entry.threadId, state)
    if (inspection?.route === 'follow') {
      state.status = 'suggested'
      this.options.suggest(entry.threadId, inspection.execution === 'running' || inspection.execution === 'waitingForInput' ? 'external_owner_running' : 'external_owner', inspection)
      return
    }
    const ownerMissing = inspection === undefined || (inspection.route === 'blocked' && inspection.writerLock?.state !== 'unheld')
    if (!ownerMissing) return
    const racing = fresh || previous?.status === 'pending'
    if (racing && state.retries < (this.options.raceRetryAttempts ?? 3)) {
      state.retries += 1
      state.status = 'pending'
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.forced.add(entry.threadId)
        this.requestScan(0)
      }, this.options.raceRetryDelayMs ?? 3_000)
      timer.unref?.()
      this.timers.add(timer)
      return
    }
    state.status = 'blocked'
  }
}

async function pool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await run(item)
    }
  })
  await Promise.all(workers)
}
