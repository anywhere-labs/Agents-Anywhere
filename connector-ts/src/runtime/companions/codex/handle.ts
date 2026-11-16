// Codex 伴随层（04 §5.2「伴随层」，research/06 §5.3）：包在通用 ACP RuntimeHandle 外面，补 codex-acp 不做、
// 必须由宿主做的事。
//
// - 自动跟随：auto-follow.ts，经运行时事件发 `native_session.follow_suggested`；
// - 打开已有线程前先 inspect：
//   · blocked、写锁确实被持有且 Codex App 在运行：打开 `codex://threads/<id>` 让 App 接手，再判定；
//   · Windows 上仍是「只因写锁 unknown 而 blocked」：这一次改用不带 `codexIpc` 的普通加载，由 Codex 自己裁决写锁；
//   · 打开仍失败时，错误里带上判定结果，会话引擎据此决定是否走「退出 App」流程；
// - 退出 App：quit-app.ts 的两步流程，经端口的 `ownerRelease` 提供；确认在触发它的 AA 会话里进行（会话层）；
// - 未加载线程的权限：rollout-settings.ts。
// 伴随层从不自行结束进程，也不在用户没打开会话时操作 App 界面（deeplink 只在打开已有线程时用）。

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type {
  Catalogs,
  HistoryWindow,
  NativeHistoryPage,
  NativeSessionPage,
  NativeSessionRef,
  OpenOptions,
  OpenTarget,
  OwnerReleaseOutcome,
  OwnerReleasePort,
  OwnerReleasePrepareResult,
  RuntimeCapabilities,
  RuntimeHandle,
  RuntimeSession,
  RuntimeType,
} from '../../../application/ports/runtime-session.js'
import { asRecord, type JsonRecord } from '../../acp/client.js'
import { RuntimeFailure } from '../../acp/errors.js'
import type { AcpRuntimeHandle } from '../../acp/handle.js'
import { runtimeError, type AcpRuntimeSession } from '../../acp/session.js'
import { CodexAutoFollow, type AutoFollowOptions } from './auto-follow.js'
import { deeplinkSupported, systemUrlOpener, threadDeeplink, type UrlOpener } from './deeplink.js'
import { currentUid, desktopAppProcesses, systemProcessTable, systemSignaller, type ProcessSignaller, type ProcessTable } from './desktop-app.js'
import { blockedOnlyByUnknownLock, CODEX_IPC_SESSIONS, inspectThread, type CodexInspection } from './inspect.js'
import { lockDirectory, type LockDirectory } from './lock-directory.js'
import { CodexAppQuitter, type QuitConsent, type QuitOutcome, type QuitPrepareResult } from './quit-app.js'
import { nativePermissionSelection } from './rollout-settings.js'

/** 打开已有线程时 codexIpc 的用法：auto（缺省）或不带 codexIpc 的普通加载。 */
export type CodexOpenRoute = 'auto' | 'plain'

export interface CodexCompanionOptions {
  readonly codexHome: string
  /** 自动跟随 Codex App 的线程（缺省开）。 */
  readonly autoFollow?: boolean
  /** 打开被 App 持有但无人应答的线程时，用 deeplink 让 App 接手（缺省开）。 */
  readonly deeplinkHandoff?: boolean
  readonly platform?: NodeJS.Platform
  /** 测试注入：写锁目录、URL opener、进程表、信号。 */
  readonly locks?: LockDirectory
  readonly opener?: UrlOpener
  readonly processes?: ProcessTable
  readonly signaller?: ProcessSignaller
  readonly uid?: number
  /** deeplink 之后等 App 登记 owner 的时间与轮询间隔。 */
  readonly handoffTimeoutMs?: number
  readonly handoffPollMs?: number
  readonly autoFollowOptions?: Partial<Omit<AutoFollowOptions, 'locks' | 'inspect' | 'isAttached' | 'suggest'>>
  readonly quitOptions?: { readonly gracePeriodMs?: number; readonly planTtlMs?: number; readonly pollMs?: number }
}

export type HandoffResult =
  | { readonly status: 'following'; readonly inspection: CodexInspection }
  | { readonly status: 'still_blocked'; readonly inspection: CodexInspection | undefined }
  | { readonly status: 'app_not_running' | 'unsupported' | 'open_failed' | 'process_table_unavailable' }

/** 实例配置里的 `codexHome`，否则 `CODEX_HOME`，否则 `~/.codex`。 */
export function resolveCodexHome(settingsHome: unknown, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const raw = typeof settingsHome === 'string' && settingsHome !== '' ? settingsHome : env.CODEX_HOME || join(home, '.codex')
  if (raw === '~') return home
  return resolve(raw.startsWith('~/') || raw.startsWith('~\\') ? join(home, raw.slice(2)) : raw)
}

export class CodexRuntimeHandle implements RuntimeHandle {
  readonly type: RuntimeType
  readonly instanceId: string
  readonly events: AcpRuntimeHandle['events']
  private readonly attached = new Set<string>()
  private readonly autoFollow: CodexAutoFollow | undefined
  private readonly quitter: CodexAppQuitter
  private readonly platform: NodeJS.Platform
  private readonly opener: UrlOpener
  private readonly processes: ProcessTable
  private readonly uid: number | undefined

  constructor(
    private readonly inner: AcpRuntimeHandle,
    /** 与 Codex 方言共享：打开某个线程时用哪种路线（只在这次 open 期间有效）。 */
    private readonly routes: Map<string, CodexOpenRoute>,
    private readonly options: CodexCompanionOptions,
  ) {
    this.type = inner.type
    this.instanceId = inner.instanceId
    this.events = inner.events
    this.platform = options.platform ?? process.platform
    this.opener = options.opener ?? systemUrlOpener(this.platform)
    this.processes = options.processes ?? systemProcessTable(this.platform)
    this.uid = 'uid' in options ? options.uid : currentUid()
    this.quitter = new CodexAppQuitter({
      table: this.processes,
      signaller: options.signaller ?? systemSignaller(this.platform),
      inspect: id => this.inspect(id),
      platform: this.platform,
      ...(this.uid !== undefined ? { uid: this.uid } : {}),
      ...options.quitOptions,
    })
    if (options.autoFollow !== false) {
      this.autoFollow = new CodexAutoFollow({
        ...options.autoFollowOptions,
        locks: options.locks ?? lockDirectory(options.codexHome),
        inspect: id => this.inspect(id),
        isAttached: id => this.attached.has(id),
        suggest: (id, reason) => this.events.push({ type: 'native_session.follow_suggested', ref: { nativeSessionId: id }, reason }),
      })
    }
  }

  /** 开始自动跟随。由 provider 在 start 之后调用；单独构造（测试）时手动调用。 */
  startCompanions(): void {
    this.autoFollow?.start()
  }

  /** 测试与诊断：立即扫一遍写锁目录。 */
  scanForFollowableThreads(): Promise<void> {
    return this.autoFollow?.scan() ?? Promise.resolve()
  }

  capabilities(): RuntimeCapabilities {
    const inner = this.inner.capabilities()
    return { ...inner, items: [...inner.items.filter(c => c.id !== 'runtime.owner_release'), { id: 'runtime.owner_release', supported: this.quitter.supported }] }
  }

  /** 端口的「释放外部持有者」：退出占着线程的 Codex App（两步，会话层确认）。 */
  readonly ownerRelease: OwnerReleasePort = {
    prepare: async (ref, context) => codexReleasePrepare(await this.quitter.prepare([ref.nativeSessionId]), ref.nativeSessionId, context.sessionId),
    execute: async (planId, consent) => codexReleaseOutcome(await this.quitter.execute(planId, consent)),
    discard: planId => this.quitter.discard(planId),
  }

  catalogs(): Promise<Catalogs> {
    return this.inner.catalogs()
  }

  listNativeSessions(cursor?: string): Promise<NativeSessionPage> {
    return this.inner.listNativeSessions(cursor)
  }

  readNativeHistory(ref: NativeSessionRef, window: HistoryWindow): Promise<NativeHistoryPage> {
    return this.inner.readNativeHistory(ref, window)
  }

  async open(target: OpenTarget, options: OpenOptions): Promise<AcpRuntimeSession> {
    if (target.kind === 'new') return this.track(await this.inner.open(target, options))
    const threadId = target.ref.nativeSessionId
    const evidence = await this.prepareOpen(threadId)
    try {
      return this.track(await this.inner.open(target, options))
    } catch (error) {
      if (evidence.inspection?.route !== 'blocked' || error instanceof RuntimeFailure) throw error
      // 带上判定结果，会话引擎据此提示用户（例如提供「退出 Codex App」）。
      const base = runtimeError(error, 'codex_owner_unavailable')
      throw new RuntimeFailure({
        ...base,
        details: {
          ...base.details,
          route: evidence.inspection.route,
          ownership: evidence.inspection.ownership,
          writerLock: evidence.inspection.writerLock?.state ?? null,
          handoff: evidence.handoff ?? null,
          ownerRelease: this.quitter.supported ? 'available' : 'unavailable',
        },
      })
    } finally {
      this.routes.delete(threadId)
    }
  }

  async stop(): Promise<void> {
    this.autoFollow?.stop()
    await this.inner.stop()
  }

  // -------------------------------------------------------------------------------------------
  // 伴随层 API（不在 RuntimeHandle 端口里）
  // -------------------------------------------------------------------------------------------

  /** 只读归属判定（`_codex/session/inspect`）。 */
  async inspect(threadId: string): Promise<CodexInspection> {
    const { client } = await this.inner.connection()
    return inspectThread(client, threadId)
  }

  /**
   * `_codex/ipc/sessions`：及时应答的 codex-acp owner 及其线程（官方 App 不响应，所以不能用来发现 App 线程）。
   * 用于 Connector 重启后发现上一代 codex-acp 仍持有的线程（04 §5.2「进程」）。
   */
  async ipcOwnerInventory(): Promise<readonly JsonRecord[]> {
    const { client } = await this.inner.connection()
    const result = asRecord(await client.request(CODEX_IPC_SESSIONS, {}, { timeoutMs: 15_000 }))
    return Array.isArray(result.owners) ? result.owners.map(asRecord) : []
  }

  /** Codex App 是否在运行；读不到进程表时 undefined。 */
  async codexAppRunning(): Promise<boolean | undefined> {
    const table = await this.processes.list()
    return table === undefined ? undefined : desktopAppProcesses(table, this.platform, this.uid).length > 0
  }

  /**
   * 让正在运行的 Codex App 接手线程：打开 `codex://threads/<id>`，等它登记为 owner。从不启动 App。
   * 只在用户要打开这个线程时用（会切换 App 当前显示的线程）。
   */
  async handoffToCodexApp(threadId: string): Promise<HandoffResult> {
    if (!deeplinkSupported(this.platform)) return { status: 'unsupported' }
    let url: string
    try {
      url = threadDeeplink(threadId)
    } catch {
      return { status: 'unsupported' }
    }
    const running = await this.codexAppRunning()
    if (running === undefined) return { status: 'process_table_unavailable' }
    if (!running) return { status: 'app_not_running' }
    if (!(await this.opener(url))) return { status: 'open_failed' }
    const deadline = Date.now() + (this.options.handoffTimeoutMs ?? 10_000)
    let inspection: CodexInspection | undefined
    for (;;) {
      inspection = await this.inspect(threadId).catch(() => undefined)
      if (inspection?.route === 'follow') return { status: 'following', inspection }
      if (Date.now() >= deadline) return { status: 'still_blocked', inspection }
      await new Promise(resolve => setTimeout(resolve, this.options.handoffPollMs ?? 500))
    }
  }

  /** 退出 Codex App 第一步：拟定计划，不发信号。计划要原样展示给用户。 */
  prepareQuitCodexApp(threadIds: readonly string[]): Promise<QuitPrepareResult> {
    return this.quitter.prepare(threadIds)
  }

  /** 退出 Codex App 第二步：只能在用户对这份计划明确同意后调用。 */
  quitCodexApp(planId: string, consent: QuitConsent): Promise<QuitOutcome> {
    return this.quitter.execute(planId, consent)
  }

  discardQuitPlan(planId: string): void {
    this.quitter.discard(planId)
  }

  /** 未加载线程当前的权限 selection ID（读 rollout 末尾）；未知时 undefined。 */
  nativePermissionSelection(threadId: string): Promise<string | undefined> {
    return nativePermissionSelection(this.options.codexHome, threadId)
  }

  // -------------------------------------------------------------------------------------------

  private async prepareOpen(threadId: string): Promise<{ inspection?: CodexInspection; handoff?: string }> {
    let inspection: CodexInspection
    try {
      inspection = await this.inspect(threadId)
    } catch {
      return {} // 判定不了就交给 codex-acp 的 auto 路线
    }
    let handoff: string | undefined
    // 只在写锁确实被持有时交给 App：Windows 上无人持有的线程也会因写锁 unknown 而 blocked，
    // 这时打开 deeplink 会把一个空闲线程塞给 App。
    if (inspection.route === 'blocked' && inspection.writerLock?.state === 'held' && this.options.deeplinkHandoff !== false) {
      const result = await this.handoffToCodexApp(threadId)
      handoff = result.status
      if ((result.status === 'following' || result.status === 'still_blocked') && result.inspection !== undefined) inspection = result.inspection
    }
    if (this.platform === 'win32' && blockedOnlyByUnknownLock(inspection)) this.routes.set(threadId, 'plain')
    return { inspection, ...(handoff !== undefined ? { handoff } : {}) }
  }

  private track<T extends RuntimeSession>(session: T): T {
    const id = session.nativeSessionId
    this.attached.add(id)
    const close = session.close.bind(session)
    ;(session as { close: () => Promise<void> }).close = async () => {
      this.attached.delete(id)
      this.autoFollow?.forget(id)
      await close()
    }
    return session
  }
}

function codexReleasePrepare(result: QuitPrepareResult, nativeSessionId: string, sessionId: string): OwnerReleasePrepareResult {
  switch (result.status) {
    case 'plan': {
      const { plan } = result
      return {
        status: 'plan',
        plan: {
          planId: plan.planId, sessionId, nativeSessionId, expiresAt: plan.expiresAt,
          owner: { displayName: 'Codex App', processCount: plan.processes.length },
          releasesOtherSessions: plan.releasesAllAppThreads,
          gracePeriodMs: plan.gracePeriodMs,
          details: JSON.parse(JSON.stringify({ processes: plan.processes, children: plan.children, threads: plan.threads, platform: plan.platform })),
        },
      }
    }
    case 'not_needed':
      return { status: 'not_needed' }
    case 'app_not_running':
      return { status: 'unavailable', reason: 'owner_not_running' }
    default:
      return { status: 'unavailable', reason: result.status }
  }
}

function codexReleaseOutcome(outcome: QuitOutcome): OwnerReleaseOutcome {
  const status: OwnerReleaseOutcome['status'] = outcome.status === 'completed' ? 'released'
    : outcome.status === 'unknown_plan' ? 'plan_expired'
    : outcome.status === 'lock_still_held' ? 'still_held'
    : outcome.status
  return { status, details: JSON.parse(JSON.stringify(outcome)) }
}
