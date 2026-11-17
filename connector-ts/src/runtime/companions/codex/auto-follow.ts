// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/ipc/service.py @98dd0e6e5 (candidate scan, bounded retry, per-state backoff)
//
// Auto-follow: finds threads the Codex App is using and, when the route is follow, suggests that the session engine
// take over (`native_session.follow_suggested`).
//
// Candidates come from the write lock directory (lock-directory.ts): scanned once at startup, then again on directory
// changes or periodic polls. Each candidate gets `_codex/session/inspect` (read-only, no resume), then:
// - route follow: suggest a takeover, only once per holding period (suggested again only after the lock file
//   disappears and reappears);
// - route blocked with a lock that is new or just changed: most likely the race where the App broadcasts following
//   before it registers ownership; retried a bounded number of times a few seconds apart; once retries run out it
//   is marked blocked and checked again at a longer interval;
// - anything else (local already held by this process, resume with no holder): no suggestion, checked again at a
//   longer interval.
// codex-acp does not receive the App's following broadcasts, so changes in the write lock directory stand in for
// them. Whether the thread is actually opened is up to the session engine.

import type { CodexInspection } from './inspect.js'
import type { LockDirectory, LockEntry } from './lock-directory.js'

export interface AutoFollowOptions {
  readonly locks: LockDirectory
  readonly inspect: (threadId: string) => Promise<CodexInspection>
  /** AA has already opened (attached to) this thread. */
  readonly isAttached: (threadId: string) => boolean
  readonly suggest: (threadId: string, reason: string, inspection: CodexInspection) => void
  /** Directory change notifications can be lost; polling is the fallback. */
  readonly pollMs?: number
  readonly debounceMs?: number
  /** Race retries: interval and count. */
  readonly raceRetryDelayMs?: number
  readonly raceRetryAttempts?: number
  /** How often to recheck a thread that is held but whose holder does not answer. */
  readonly blockedRetryMs?: number
  /** How often to recheck a thread with no holder or held by this process. */
  readonly settledRetryMs?: number
  /** At most how many of the newest lock files to look at per scan. */
  readonly recentLimit?: number
  /** Concurrent inspects (with no owner each waits for the IPC discovery timeout, about 5 seconds). */
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

  /** The session engine closed the thread: it can be suggested again. */
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

  /** Scans once; if another request arrives during the scan, scans again afterwards (no notification is lost). */
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
    // The lock file is gone: this holding period is over; forget the state and suggest again if it reappears.
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

  /** undefined: skip this time; true: new or just changed (possibly in the race); false: recheck on the interval. */
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
      // Retries accumulate within one holding period (lock file unchanged).
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
