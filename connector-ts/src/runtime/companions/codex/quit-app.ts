// 退出 Codex App（v2 `/kill-chatgpt`），按 codex-acp docs/session-ownership.md「Last-resort termination flow」：
//
// 1. 先刷新归属判定：线程能跟随（route follow）就不需要退出 App；
// 2. 拟定具体计划：要结束哪些进程（带身份）、会影响哪些线程、宽限多久、是否允许强制；
// 3. 用户对这份计划明确同意（单次有效、有过期时间；计划变了要重新同意）；
// 4. 发信号前复核进程身份（PID + 启动时间 + 可执行文件 + 用户）和线程关系，变了就不发；
// 5. 先请求有序退出，宽限期后仍在且用户同意过强制时才强制；
// 6. 确认进程确实退出、写锁确实释放；
// 7. 重新判定归属：别的客户端可能已经接手；
// 8. 之后由会话引擎按正常路线重新打开同一线程（这里只报告，不自动 resume）。
//
// 伴随层从不删除写锁文件。

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
  /** 要结束的 App 主进程。 */
  readonly processes: readonly ProcessInfo[]
  /** 主进程的子进程：随主进程退出（Windows 上一起结束），退出后要复核。 */
  readonly children: readonly ProcessInfo[]
  /** 目标线程（用户要接手的）在拟定计划时的状态。 */
  readonly threads: readonly QuitPlanThread[]
  /** App 里正在加载的其它线程都会被一起释放，这里无法逐一列出（Codex App 不公开清单）。 */
  readonly releasesAllAppThreads: true
  readonly gracePeriodMs: number
  readonly platform: NodeJS.Platform
}

export type QuitPrepareResult =
  | { readonly status: 'plan'; readonly plan: QuitPlan }
  /** 线程可以跟随或已经无人持有，不需要退出 App。 */
  | { readonly status: 'not_needed'; readonly threads: readonly QuitPlanThread[] }
  | { readonly status: 'app_not_running' }
  | { readonly status: 'platform_unsupported' }
  | { readonly status: 'process_table_unavailable' }

export interface QuitConsent {
  /** 宽限期后仍未退出时允许强制结束（SIGKILL / taskkill /F）。 */
  readonly force: boolean
}

export type QuitStatus =
  /** 进程已退出，目标线程写锁已释放（或平台无法判定时为 unknown，见 threads）。 */
  | 'completed'
  /** 线程已经被释放，没有发信号。 */
  | 'already_released'
  /** 计划不存在、已用过或已过期，需要重新拟定并征得同意。 */
  | 'unknown_plan'
  | 'plan_expired'
  /** 进程身份或数量变了（PID 复用、App 重启、多了一个实例），没有发信号。 */
  | 'plan_changed'
  /** 宽限期后仍有主进程存活，且用户没有同意强制。 */
  | 'survivors'
  /** 进程都退出了，但写锁仍被持有（别的进程接手了，或子进程还在）。 */
  | 'lock_still_held'

export interface QuitOutcome {
  readonly status: QuitStatus
  readonly terminated: readonly number[]
  readonly killed: readonly number[]
  readonly survivors: readonly number[]
  /** 退出后仍在的子进程（只报告，不另发信号）。 */
  readonly childSurvivors: readonly number[]
  readonly threads: readonly QuitPlanThread[]
}

export interface CodexAppQuitterOptions {
  readonly table: ProcessTable
  readonly signaller: ProcessSignaller
  /** 只读归属判定（`_codex/session/inspect`）。 */
  readonly inspect: (threadId: string) => Promise<CodexInspection>
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  readonly gracePeriodMs?: number
  /** 计划多久内必须确认。 */
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

  /** 第一步：拟定计划，不发任何信号。 */
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

  /** 放弃一份计划（用户拒绝或关闭了确认）。 */
  discard(planId: string): void {
    this.plans.delete(planId)
  }

  /** 第二步：用户同意后执行。计划单次有效。 */
  async execute(planId: string, consent: QuitConsent): Promise<QuitOutcome> {
    const plan = this.plans.get(planId)
    this.plans.delete(planId)
    const empty = { terminated: [], killed: [], survivors: [], childSurvivors: [] }
    if (plan === undefined) return { status: 'unknown_plan', ...empty, threads: [] }
    if (this.now() > plan.expiresAt) return { status: 'plan_expired', ...empty, threads: plan.threads }

    // 复核：进程身份与计划一致，目标线程仍被持有。
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

    // 有序退出，宽限期内轮询进程表（按身份判断，不按 PID）。
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
    // route 为 follow 说明别的客户端已经接手，交给会话引擎按 auto 路线跟随它；只有写锁仍 held 才算失败。
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
    // 读不到进程表时不能断言已经退出。
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

/** 给用户看的计划说明（确认卡片正文）。 */
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
