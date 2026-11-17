// Quits the Codex App, following codex-acp docs/session-ownership.md "Last-resort termination flow":
//
// 1. Refresh the ownership check first: if the thread can be followed (route follow), there is no need to quit;
// 2. draft a concrete plan: which processes to end (with identities), which threads are affected, the grace period,
//    and whether forcing is allowed;
// 3. the user explicitly agrees to this plan (single use, with an expiry; a changed plan needs new agreement);
// 4. before signalling, recheck process identities (PID + start time + executable + user) and thread relations, and
//    send nothing if they changed;
// 5. request an orderly exit first, and force only if processes remain after the grace period and the user agreed
//    to forcing;
// 6. confirm the processes really exited and the write lock really was released;
// 7. check ownership again: another client may have taken over;
// 8. afterwards the session engine reopens the same thread on the normal route (this only reports, never resumes).
//
// The companion layer never deletes write lock files.

import { randomUUID } from 'node:crypto'

import type { CodexInspection } from './inspect.js'
import {
  currentUid,
  descendants,
  desktopAppProcesses,
  processKey,
  quitSupported,
  type ProcessInfo,
  type ProcessSignaller,
  type ProcessTable,
} from './desktop-app.js'

export interface QuitPlanThread {
  readonly threadId: string
  readonly route: CodexInspection['route']
  readonly writerLock: 'held' | 'unheld' | 'unknown' | 'not_probed'
}

export interface QuitPlan {
  readonly planId: string
  readonly createdAt: number
  readonly expiresAt: number
  /** App main processes to end. */
  readonly processes: readonly ProcessInfo[]
  /** Children of the main processes: they exit with them (ended together on Windows) and are rechecked afterwards. */
  readonly children: readonly ProcessInfo[]
  /** State of the target thread (the one the user wants to take over) when the plan was drafted. */
  readonly threads: readonly QuitPlanThread[]
  /** Every other thread loaded in the App is released too; they cannot be listed here (the Codex App does not expose the list). */
  readonly releasesAllAppThreads: true
  readonly gracePeriodMs: number
  readonly platform: NodeJS.Platform
}

export type QuitPrepareResult =
  | { readonly status: 'plan'; readonly plan: QuitPlan }
  /** The thread can be followed or is no longer held: no need to quit the App. */
  | { readonly status: 'not_needed'; readonly threads: readonly QuitPlanThread[] }
  | { readonly status: 'app_not_running' }
  | { readonly status: 'platform_unsupported' }
  | { readonly status: 'process_table_unavailable' }

export interface QuitConsent {
  /** Allow a forced end (SIGKILL / taskkill /F) if processes remain after the grace period. */
  readonly force: boolean
}

export type QuitStatus =
  /** The processes exited and the target thread's write lock was released (unknown when the platform cannot tell, see threads). */
  | 'completed'
  /** The thread was already released; no signal sent. */
  | 'already_released'
  /** The plan does not exist, was used or has expired; it must be drafted and agreed to again. */
  | 'unknown_plan'
  | 'plan_expired'
  /** Process identities or count changed (PID reuse, App restart, an extra instance); no signal sent. */
  | 'plan_changed'
  /** A main process is still alive after the grace period and the user did not agree to forcing. */
  | 'survivors'
  /** The processes all exited but the write lock is still held (another process took over, or a child is still alive). */
  | 'lock_still_held'

export interface QuitOutcome {
  readonly status: QuitStatus
  readonly terminated: readonly number[]
  readonly killed: readonly number[]
  readonly survivors: readonly number[]
  /** Children still alive after the exit (reported only, no extra signal). */
  readonly childSurvivors: readonly number[]
  readonly threads: readonly QuitPlanThread[]
}

export interface CodexAppQuitterOptions {
  readonly table: ProcessTable
  readonly signaller: ProcessSignaller
  /** Read-only ownership check (`_codex/session/inspect`). */
  readonly inspect: (threadId: string) => Promise<CodexInspection>
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  readonly gracePeriodMs?: number
  /** How long a plan stays confirmable. */
  readonly planTtlMs?: number
  readonly pollMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

const DEFAULT_GRACE_MS = 5_000
const DEFAULT_PLAN_TTL_MS = 120_000
const DEFAULT_POLL_MS = 200
const FORCE_WAIT_MS = 1_000

function threadState(threadId: string, inspection: CodexInspection): QuitPlanThread {
  return { threadId, route: inspection.route, writerLock: inspection.writerLock?.state ?? 'not_probed' }
}

export class CodexAppQuitter {
  private readonly plans = new Map<string, QuitPlan>()
  private readonly platform: NodeJS.Platform
  private readonly uid: number | undefined
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: CodexAppQuitterOptions) {
    this.platform = options.platform ?? process.platform
    this.uid = 'uid' in options ? options.uid : currentUid()
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  get supported(): boolean {
    return quitSupported(this.platform)
  }

  /** Step one: draft the plan without sending any signal. */
  async prepare(threadIds: readonly string[]): Promise<QuitPrepareResult> {
    if (!this.supported) return { status: 'platform_unsupported' }
    const threads = await Promise.all(threadIds.map(async id => threadState(id, await this.options.inspect(id))))
    const blocked = threads.filter(t => t.route === 'blocked' && t.writerLock !== 'unheld')
    if (threadIds.length > 0 && blocked.length === 0) return { status: 'not_needed', threads }
    const table = await this.options.table.list()
    if (table === undefined) return { status: 'process_table_unavailable' }
    const processes = desktopAppProcesses(table, this.platform, this.uid)
    if (processes.length === 0) return { status: 'app_not_running' }
    const children = processes.flatMap(p => descendants(table, p))
    const createdAt = this.now()
    const plan: QuitPlan = {
      planId: randomUUID(),
      createdAt,
      expiresAt: createdAt + (this.options.planTtlMs ?? DEFAULT_PLAN_TTL_MS),
      processes,
      children,
      threads,
      releasesAllAppThreads: true,
      gracePeriodMs: this.options.gracePeriodMs ?? DEFAULT_GRACE_MS,
      platform: this.platform,
    }
    this.plans.set(plan.planId, plan)
    return { status: 'plan', plan }
  }

  /** Discards a plan (the user refused or closed the confirmation). */
  discard(planId: string): void {
    this.plans.delete(planId)
  }

  /** Step two: execute after the user agrees. A plan is single use. */
  async execute(planId: string, consent: QuitConsent): Promise<QuitOutcome> {
    const plan = this.plans.get(planId)
    this.plans.delete(planId)
    const empty = { terminated: [], killed: [], survivors: [], childSurvivors: [] }
    if (plan === undefined) return { status: 'unknown_plan', ...empty, threads: [] }
    if (this.now() > plan.expiresAt) return { status: 'plan_expired', ...empty, threads: plan.threads }

    // Recheck: process identities match the plan and the target thread is still held.
    const table = await this.options.table.list()
    if (table === undefined) return { status: 'plan_changed', ...empty, threads: plan.threads }
    const planned = new Set(plan.processes.map(processKey))
    const current = desktopAppProcesses(table, this.platform, this.uid)
    if (current.some(p => !planned.has(processKey(p)))) return { status: 'plan_changed', ...empty, threads: plan.threads }
    const before = await this.inspectAll(plan)
    if (plan.threads.length > 0 && !before.some(t => t.route === 'blocked' && t.writerLock !== 'unheld')) {
      return { status: 'already_released', ...empty, threads: before }
    }
    if (current.length === 0) return { status: 'already_released', ...empty, threads: before }

    // Orderly exit; poll the process table during the grace period (by identity, not by PID).
    for (const p of current) await this.options.signaller.terminate(p)
    let alive = await this.waitForExit(current, plan.gracePeriodMs)
    const killed: number[] = []
    if (alive.length > 0 && consent.force) {
      for (const p of alive) {
        await this.options.signaller.kill(p)
        killed.push(p.pid)
      }
      alive = await this.waitForExit(alive, FORCE_WAIT_MS)
    }
    const terminated = current.filter(p => !killed.includes(p.pid) && !alive.includes(p)).map(p => p.pid)
    const survivors = alive.map(p => p.pid)
    const childSurvivors = (await this.alive(plan.children)).map(p => p.pid)
    const after = await this.inspectAll(plan)
    if (survivors.length > 0) return { status: 'survivors', terminated, killed, survivors, childSurvivors, threads: after }
    // route follow means another client took over; leave it to the session engine to follow on the auto route. Only a write lock still held counts as failure.
    const stillHeld = after.some(t => t.writerLock === 'held')
    return { status: stillHeld ? 'lock_still_held' : 'completed', terminated, killed, survivors, childSurvivors, threads: after }
  }

  private async inspectAll(plan: QuitPlan): Promise<QuitPlanThread[]> {
    return Promise.all(plan.threads.map(async t => {
      try {
        return threadState(t.threadId, await this.options.inspect(t.threadId))
      } catch {
        return { threadId: t.threadId, route: 'blocked' as const, writerLock: 'unknown' as const }
      }
    }))
  }

  private async alive(processes: readonly ProcessInfo[]): Promise<ProcessInfo[]> {
    if (processes.length === 0) return []
    const table = await this.options.table.list()
    // Without a process table we cannot assert the processes exited.
    if (table === undefined) return [...processes]
    const present = new Set(table.map(processKey))
    return processes.filter(p => present.has(processKey(p)))
  }

  private async waitForExit(processes: readonly ProcessInfo[], timeoutMs: number): Promise<ProcessInfo[]> {
    const deadline = this.now() + timeoutMs
    let alive = await this.alive(processes)
    while (alive.length > 0 && this.now() < deadline) {
      await this.sleep(this.options.pollMs ?? DEFAULT_POLL_MS)
      alive = await this.alive(alive)
    }
    return alive
  }
}

/** Plan description shown to the user (confirmation card body). */
export function describeQuitPlan(plan: QuitPlan): string {
  const lines = [
    '退出 Codex App 会释放它正在使用的所有线程，App 里未保存的输入和正在运行的回合会中断。',
    `将结束的进程：${plan.processes.map(p => `${p.executable}（PID ${p.pid}，启动于 ${p.startedAt}）`).join('；')}`,
  ]
  if (plan.children.length) lines.push(`其子进程 ${plan.children.length} 个会随之退出。`)
  for (const t of plan.threads) lines.push(`线程 ${t.threadId}：当前无法跟随（写锁 ${t.writerLock}）。`)
  lines.push(`先请求正常退出，等待 ${Math.round(plan.gracePeriodMs / 1000)} 秒；只有选择「必要时强制」才会强制结束。`)
  lines.push('退出后需要重新打开会话，才会由 Agents Anywhere 接手这个线程。')
  return lines.join('\n')
}
