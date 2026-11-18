// Codex companion layer (04 §5.2 "companion layer", research/06 §5.3): wraps the generic ACP RuntimeHandle and adds
// what codex-acp does not do and the host must do.
//
// - Auto-follow: auto-follow.ts, emitting `native_session.follow_suggested` through runtime events;
// - inspect before opening an existing thread:
//   - blocked, the write lock really held and the Codex App running: open `codex://threads/<id>` so the App takes
//     over, then check again;
//   - still blocked on Windows only because the write lock is unknown: this time use a plain load without
//     `codexIpc` and let Codex arbitrate the write lock itself;
//   - when opening still fails, the error carries the inspection result, and the session engine decides from it
//     whether to go through the "quit the App" flow;
// - quitting the App: the two-step flow in quit-app.ts, offered through the port's `ownerRelease`; confirmation
//   happens in the AA session that triggered it (session layer);
// - permissions of unloaded threads: rollout-settings.ts.
// The companion layer never ends processes on its own, and never touches the App UI when the user has not opened a
// session (the deeplink is used only when opening an existing thread).

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type {
  AgentProcessInfo,
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

/** How codexIpc is used when opening an existing thread: auto (default) or a plain load without codexIpc. */
export type CodexOpenRoute = 'auto' | 'plain'

export interface CodexCompanionOptions {
  readonly codexHome: string
  /** Auto-follow Codex App threads (on by default). */
  readonly autoFollow?: boolean
  /** When opening a thread the App holds but does not answer for, use a deeplink so the App takes over (on by default). */
  readonly deeplinkHandoff?: boolean
  readonly platform?: NodeJS.Platform
  /** Test injection: write lock directory, URL opener, process table, signals. */
  readonly locks?: LockDirectory
  readonly opener?: UrlOpener
  readonly processes?: ProcessTable
  readonly signaller?: ProcessSignaller
  readonly uid?: number
  /** Time to wait after the deeplink for the App to register as owner, and the polling interval. */
  readonly handoffTimeoutMs?: number
  readonly handoffPollMs?: number
  readonly autoFollowOptions?: Partial<Omit<AutoFollowOptions, 'locks' | 'inspect' | 'isAttached' | 'suggest'>>
  readonly quitOptions?: { readonly gracePeriodMs?: number; readonly planTtlMs?: number; readonly pollMs?: number }
}

export type HandoffResult =
  | { readonly status: 'following'; readonly inspection: CodexInspection }
  | { readonly status: 'still_blocked'; readonly inspection: CodexInspection | undefined }
  | { readonly status: 'app_not_running' | 'unsupported' | 'open_failed' | 'process_table_unavailable' }

/** `codexHome` from the instance config, else `CODEX_HOME`, else `~/.codex`. */
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
    /** Shared with the Codex dialect: which route to use when opening a thread (valid only during that open). */
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

  /** Starts auto-follow. Called by the provider after start; call it manually when constructed on its own (tests). */
  startCompanions(): void {
    this.autoFollow?.start()
  }

  /** Tests and diagnostics: scans the write lock directory now. */
  scanForFollowableThreads(): Promise<void> {
    return this.autoFollow?.scan() ?? Promise.resolve()
  }

  capabilities(): RuntimeCapabilities {
    const inner = this.inner.capabilities()
    return { ...inner, items: [...inner.items.filter(c => c.id !== 'runtime.owner_release'), { id: 'runtime.owner_release', supported: this.quitter.supported }] }
  }

  /** The port's "release the external holder": quits the Codex App holding the thread (two steps, confirmed by the session layer). */
  readonly ownerRelease: OwnerReleasePort = {
    prepare: async (ref, context) => codexReleasePrepare(await this.quitter.prepare([ref.nativeSessionId]), ref.nativeSessionId, context.sessionId),
    execute: async (planId, consent) => codexReleaseOutcome(await this.quitter.execute(planId, consent)),
    discard: planId => this.quitter.discard(planId),
  }

  catalogs(sessionId?: string): Promise<Catalogs> {
    return this.inner.catalogs(sessionId)
  }

  /** Native session inventory; threads not yet opened get the permission recorded in their rollout (port `NativeSessionSummary.permission`). */
  async listNativeSessions(cursor?: string): Promise<NativeSessionPage> {
    const page = await this.inner.listNativeSessions(cursor)
    const sessions = await mapLimited(page.sessions, PERMISSION_READS, async session => {
      if (session.permission !== undefined || this.attached.has(session.nativeSessionId)) return session
      const permission = await this.cachedPermission(session.nativeSessionId, session.updatedAt)
      return permission !== undefined ? { ...session, permission } : session
    })
    return { ...page, sessions }
  }

  private readonly permissionCache = new Map<string, { readonly updatedAt: string | undefined; readonly permission: string | undefined }>()

  /** A thread's rollout is not reread while its updatedAt is unchanged. */
  private async cachedPermission(threadId: string, updatedAt: string | undefined): Promise<string | undefined> {
    const cached = this.permissionCache.get(threadId)
    if (cached !== undefined && updatedAt !== undefined && cached.updatedAt === updatedAt) return cached.permission
    const permission = await this.nativePermissionSelection(threadId).catch(() => undefined)
    this.permissionCache.set(threadId, { updatedAt, permission })
    return permission
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
      // Carry the inspection result so the session engine can prompt the user (e.g. offer "quit the Codex App").
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

  agentProcesses(): AgentProcessInfo[] {
    return this.inner.agentProcesses()
  }

  async stop(): Promise<void> {
    this.autoFollow?.stop()
    await this.inner.stop()
  }

  // -------------------------------------------------------------------------------------------
  // Companion layer API (not part of the RuntimeHandle port)
  // -------------------------------------------------------------------------------------------

  /** Read-only ownership check (`_codex/session/inspect`). */
  async inspect(threadId: string): Promise<CodexInspection> {
    const { client } = await this.inner.connection()
    return inspectThread(client, threadId)
  }

  /**
   * `_codex/ipc/sessions`: codex-acp owners that answer promptly and their threads (the official App does not
   * answer, so this cannot discover App threads). Used after a Connector restart to find threads the previous
   * codex-acp generation still holds (04 §5.2 "processes").
   */
  async ipcOwnerInventory(): Promise<readonly JsonRecord[]> {
    const { client } = await this.inner.connection()
    const result = asRecord(await client.request(CODEX_IPC_SESSIONS, {}, { timeoutMs: 15_000 }))
    return Array.isArray(result.owners) ? result.owners.map(asRecord) : []
  }

  /** Whether the Codex App is running; undefined when the process table cannot be read. */
  async codexAppRunning(): Promise<boolean | undefined> {
    const table = await this.processes.list()
    return table === undefined ? undefined : desktopAppProcesses(table, this.platform, this.uid).length > 0
  }

  /**
   * Lets the running Codex App take over a thread: opens `codex://threads/<id>` and waits for it to register as
   * owner. Never launches the App. Used only when the user opens this thread (it switches the thread the App shows).
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

  /** Quitting the Codex App, step one: draft the plan without sending signals. The plan must be shown to the user as is. */
  prepareQuitCodexApp(threadIds: readonly string[]): Promise<QuitPrepareResult> {
    return this.quitter.prepare(threadIds)
  }

  /** Quitting the Codex App, step two: call only after the user explicitly agrees to this plan. */
  quitCodexApp(planId: string, consent: QuitConsent): Promise<QuitOutcome> {
    return this.quitter.execute(planId, consent)
  }

  discardQuitPlan(planId: string): void {
    this.quitter.discard(planId)
  }

  /** Current permission selection ID of an unloaded thread (read from the rollout tail); undefined when unknown. */
  nativePermissionSelection(threadId: string): Promise<string | undefined> {
    return nativePermissionSelection(this.options.codexHome, threadId)
  }

  // -------------------------------------------------------------------------------------------

  private async prepareOpen(threadId: string): Promise<{ inspection?: CodexInspection; handoff?: string }> {
    let inspection: CodexInspection
    try {
      inspection = await this.inspect(threadId)
    } catch {
      return {} // when it cannot be determined, leave it to codex-acp's auto route
    }
    let handoff: string | undefined
    // Hand over to the App only when the write lock really is held: on Windows an unheld thread is also blocked
    // because the write lock is unknown, and opening a deeplink then would push an idle thread onto the App.
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

/** How many rollouts to read at once: a session list page usually has dozens, reading file tails is fast, but do not open too many files at once. */
const PERMISSION_READS = 4

async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index]!)
    }
  }))
  return results
}
