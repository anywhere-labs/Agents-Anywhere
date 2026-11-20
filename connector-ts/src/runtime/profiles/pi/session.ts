// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/dialect.py @98dd0e6e5 (PiDialect.interaction, plan_review, prompt_cancelled, authorize_bash, classify_error)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/native_runtime.py @98dd0e6e5 (NativePiRuntime handoff, _check_source)
//
// Pi session: one Pi process per AA session, wrapping the generic ACP session (runtime/acp/session.ts). It handles
// approval forms, plan review, the synthesized permission / plan config options, `/bash` authorization, and handoff
// (locks, write verification, source checks).
//
// Behaviour (04-connector.md §5.4):
// - Processes are reclaimed per session when idle: after `idleMs` the process stops and the session goes dormant; the
//   next prompt / configure / command restarts it from the latest native file, with no visible disconnect on the port
//   (no session.lost).
// - No manual resume after a Connector restart: open(existing) starts the process directly from a native file checked
//   read-only. The SDK bridge's write verification covers other writers (if another writer changed the file, AA
//   refuses to keep writing and syncs the latest history).
// - A turn has no hard timeout: the generic engine sets no timeout on session/prompt; turns are driven by the
//   Runtime's end or an interrupt.

import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  AgentProcessInfo,
  Capability,
  CommandResult,
  ConfigChange,
  ConfigOption,
  ConfigResult,
  DeliveryRef,
  InteractionAnswer,
  InteractionRefusal,
  JsonObject,
  NewSessionSpec,
  PlanningPort,
  PromptAcceptance,
  PromptInput,
  RuntimeError,
  RuntimeEvent,
  RuntimeSession,
  SessionCapabilities,
  SteerResult,
  ToolServerSpec,
} from '../../../application/ports/runtime-session.js'
import { acpFingerprint } from '../../../domain/identity/index.js'
import { asRecord } from '../../acp/client.js'
import { findOption } from '../../acp/config.js'
import type { AcpDialect } from '../../acp/dialect.js'
import { fail, RuntimeFailure } from '../../acp/errors.js'
import type { AcpRuntimeHandle } from '../../acp/handle.js'
import { JsonRpcError } from '../../acp/jsonrpc.js'
import { EventQueue } from '../../acp/queue.js'
import { runtimeError, type AcpRuntimeSession } from '../../acp/session.js'
import { piHistoryEvents, piTimeline, type PiHistory, type PiNativeIndex, type PiSource } from '../../companions/native-history/index.js'
import { fileLock } from '../../supervisor/npm-runtime.js'
import type { PiSessionAliases } from './aliases.js'
import {
  GUARD_FAILED,
  PERMISSION_OPTION,
  PERMISSIONS,
  PLAN_OPTION,
  PLAN_REVIEW_PREFIX,
  piDialect,
  piDialectState,
  TOOL_PERMISSION_PREFIX,
  type PiDialectState,
  type PiPermission,
} from './dialect.js'
import { privateJson } from './settings.js'

const PLAN_CAPABILITIES: readonly Capability[] = [
  // A new session can start in plan mode from a prepared workspace (the planning intent of its creation).
  { id: 'session.planning', supported: true, parameters: { preparedCreation: true } },
  { id: 'session.plan_document', supported: true },
  { id: 'session.plan_review', supported: true },
]

/** Agent operations Pi answers from what this adapter knows (`operate`). */
const AGENT_CAPABILITIES: readonly Capability[] = [
  { id: 'session.authentication.read', supported: true },
  { id: 'session.resources.read', supported: true },
]

const PERMISSION_LABELS: Readonly<Record<PiPermission, string>> = { ask: '写入与命令审批', ask_all: '全部工具审批', readonly: '只读' }

/**
 * Permission mode per native session ID (the guard reads this file on every tool call). Read-modify-write is serialised
 * within an instance.
 */
export class PermissionStore {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string) {}

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  async get(nativeSessionId: string): Promise<PiPermission> {
    await this.chain.catch(() => undefined)
    const value = (await this.read())[nativeSessionId]
    return (PERMISSIONS as readonly string[]).includes(value ?? '') ? value as PiPermission : 'ask'
  }

  set(nativeSessionId: string, value: PiPermission): Promise<void> {
    const next = this.chain.catch(() => undefined).then(async () => {
      const current = await this.read()
      current[nativeSessionId] = value
      await privateJson(this.file, current)
    })
    this.chain = next
    return next
  }
}

/** What a Pi session gets from its instance. */
export interface PiSessionHost {
  readonly instanceId: string
  readonly index: PiNativeIndex
  readonly permissions: PermissionStore
  /** Native session ID aliases: recorded when a session changes native ID, so the original ID is always reported. */
  readonly aliases: PiSessionAliases
  /** Plan mode marker directory (the guard reads the same directory). */
  readonly planningDir: string
  /** Directory of write verification files (the SDK bridge reports a digest after each write to the native file). */
  readonly stateDir: string
  /** Only one AA process may write a given native file (across Connector instances). */
  readonly lockDir: string
  readonly idleMs: number
  /** A new single-process handle; the process gets session-specific environment variables and starts on the first open. */
  spawn(environment: Readonly<Record<string, string>>, dialect: AcpDialect): AcpRuntimeHandle
  /** The session received new capabilities and config (the instance's catalog and capabilities follow). */
  observe(capabilities: readonly Capability[], config: readonly ConfigOption[]): void
  released(session: PiRuntimeSession): void
}

interface Active {
  readonly handle: AcpRuntimeHandle
  readonly inner: AcpRuntimeSession
  readonly dialect: PiDialectState
  /** When started from a native file: the pinned file and the write verification file. */
  readonly pinned?: { readonly path: string; readonly stateFile: string }
  readonly pump: Promise<void>
}

type Synthetic =
  | { readonly kind: 'tool' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'bash'; readonly resolve: (allowed: boolean) => void }

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function invalidParams(message: string): never {
  throw new JsonRpcError(-32602, message)
}

export interface PiOpenNew {
  readonly kind: 'new'
  readonly spec: NewSessionSpec
}

export interface PiOpenExisting {
  readonly kind: 'existing'
  readonly source: PiSource
  readonly replay: 'none' | 'full'
}

export class PiRuntimeSession implements RuntimeSession {
  readonly events = new EventQueue<RuntimeEvent>()
  readonly planning: PlanningPort
  /** Actual native ID in the current Pi process (used for the process, locks, permission, plan markers, write verification). */
  private native = ''
  /** Native ID reported externally: the original one, unchanged even after the native session changes (aliases.ts). */
  private external = ''
  private cwd = ''
  /** Known native file (a new session has one only after Pi's first write). */
  private file: string | undefined
  private active: Active | undefined
  private waking: Promise<Active> | undefined
  private state: 'starting' | 'active' | 'dormant' | 'closed' = 'starting'
  /** The process is about to stop on purpose (dormancy, close): session.lost is not reported then. */
  private retiring = false
  /**
   * Native file digest at dormancy: if it changed on wakeup, another writer continued the session, so the full history
   * is synced once.
   */
  private dormantRevision: string | undefined
  private releaseLock: (() => Promise<void>) | undefined
  private innerConfig: readonly ConfigOption[] = []
  private permission: PiPermission = 'ask'
  private planMode = false
  private lastCapabilities: readonly Capability[] = []
  /** The slash commands Pi reported last (`resources.get`). */
  private commands: readonly { readonly name: string; readonly description?: string }[] = []
  private capabilityRevision = 1
  private readonly toolItems = new Map<string, string>()
  private readonly synthetic = new Map<string, Synthetic>()
  /**
   * The user chose not to run the plan in the current turn: Pi ends the run with an interrupt, and the turn counts as
   * cancelled, not failed.
   */
  private planDismissed = false
  /** Turn in progress (as reported by the generic session): if the process stops early, the turn end is emitted from here. */
  private openTurn: string | undefined
  private lastActivity = Date.now()
  private idleTimer: ReturnType<typeof setInterval> | undefined

  /** The AA session id; a prepared session starts with its preparation id and `rebind` gives it the real one. */
  sessionId: string

  /** Collaboration tool servers, injected again whenever the inner Agent session is reopened. */
  private toolServers: readonly ToolServerSpec[] = []

  private innerOptions(): { sessionId: string; replay: 'none'; toolServers?: readonly ToolServerSpec[] } {
    return { sessionId: this.sessionId, replay: 'none', ...(this.toolServers.length > 0 ? { toolServers: this.toolServers } : {}) }
  }

  private constructor(sessionId: string, private readonly host: PiSessionHost) {
    this.sessionId = sessionId
    this.planning = {
      setMode: async mode => {
        await this.configure({ optionId: PLAN_OPTION, value: mode })
      },
      current: async () => ({ mode: this.planMode ? 'plan' : 'normal' }),
    }
  }

  /** Creates or attaches a session; on failure the process and lock have already been released. */
  static async open(host: PiSessionHost, sessionId: string, target: PiOpenNew | PiOpenExisting, toolServers: readonly ToolServerSpec[] = []): Promise<PiRuntimeSession> {
    const session = new PiRuntimeSession(sessionId, host)
    session.toolServers = toolServers
    try {
      if (target.kind === 'new') await session.startNew(target.spec)
      else await session.startExisting(target.source, target.replay)
    } catch (error) {
      await session.shutdown()
      throw error
    }
    session.state = 'active'
    session.watchIdle()
    return session
  }

  get nativeSessionId(): string {
    return this.external
  }

  get capabilities(): SessionCapabilities {
    const items = [...(this.active?.inner.capabilities.items ?? this.lastCapabilities)]
    const own = [...PLAN_CAPABILITIES, ...AGENT_CAPABILITIES]
    return { revision: this.capabilityRevision, items: [...items.filter(item => !own.some(entry => entry.id === item.id)), ...own] }
  }

  get configOptions(): readonly ConfigOption[] {
    return [...this.innerConfig, this.planOption(), this.permissionOption()]
  }

  /** Plan mode is the synthetic plan option. */
  get planningOptionId(): string {
    return PLAN_OPTION
  }

  /** A prepared session becomes its AA session (before its first message). */
  rebind(sessionId: string): void {
    if (sessionId === this.sessionId) return
    this.sessionId = sessionId
    this.active?.inner.rebind(sessionId)
  }

  get busy(): boolean {
    return this.active?.inner.busy === true || this.synthetic.size > 0
  }

  /** This session's Pi process while it is awake (`RuntimeHandle.agentProcesses`). */
  agentProcesses(): AgentProcessInfo[] {
    return (this.active?.handle.agentProcesses() ?? []).map(process => ({ pid: process.pid, sessionIds: [this.sessionId] }))
  }

  // ------------------------------------------------------------------------------------------
  // Open
  // ------------------------------------------------------------------------------------------

  private async startNew(spec: NewSessionSpec): Promise<void> {
    const selections = { ...(spec.selections ?? {}) }
    const permission = selections.permission
    const mode = selections.mode
    delete selections.permission
    delete selections.mode
    if (permission !== undefined && permission !== null && !(PERMISSIONS as readonly string[]).includes(permission)) fail('invalid_configuration_value', '权限选项无效。')
    if (mode !== undefined && mode !== null && mode !== 'plan' && mode !== 'normal') fail('invalid_configuration_value', 'Pi 规划模式值无效。')
    const dialectState = piDialectState()
    const handle = this.host.spawn({}, piDialect(dialectState))
    let inner: AcpRuntimeSession
    try {
      inner = await handle.open({ kind: 'new', spec: { ...spec, selections } }, this.innerOptions())
    } catch (error) {
      await handle.stop().catch(() => undefined)
      throw classifyOpen(error)
    }
    this.native = inner.nativeSessionId
    this.external = this.native
    this.cwd = spec.cwd
    this.file = dialectState.sessionFiles.get(this.native) ?? undefined
    this.attach({ handle, inner, dialect: dialectState, pump: Promise.resolve() })
    if (permission) await this.setPermission(permission as PiPermission)
    else this.permission = await this.host.permissions.get(this.native)
    if (mode === 'plan') await this.setPlanMode(true)
    this.emitConfig()
  }

  private async startExisting(source: PiSource, replay: 'none' | 'full'): Promise<void> {
    if (source.ambiguous) fail('pi_source_ambiguous', '多个历史文件具有相同会话身份，请先确认来源。')
    this.native = source.nativeSessionId
    this.external = source.externalSessionId
    this.cwd = source.cwd
    this.file = source.path
    const history = await this.host.index.read(source.path)
    history.requireResumable()
    if (replay === 'full') for (const event of this.historyEvents(history)) this.events.push(event)
    this.permission = await this.host.permissions.get(this.native)
    this.planMode = await this.planMarkerExists()
    await this.activate()
    this.emitConfig()
  }

  /** Starts a Pi process from the native file and resumes (used for handoff, after a Connector restart, and on wakeup). */
  private async activate(): Promise<Active> {
    const file = this.file
    if (file === undefined) fail('pi_source_missing', '原生历史来源暂时不可用。')
    const history = await this.host.index.read(file)
    if (history.nativeId !== this.native) fail('pi_source_identity_changed', '原生历史身份已变化，不能继续原绑定。')
    history.requireResumable()
    if (this.releaseLock === undefined) this.releaseLock = await this.lock(history.path)
    const stateFile = join(this.host.stateDir, `pi-writes-${acpFingerprint(this.sessionId)}.json`)
    await rm(stateFile, { force: true })
    const dialectState = piDialectState()
    const handle = this.host.spawn({
      AA_PI_SESSION_FILE: history.path,
      AA_PI_SESSION_ID: history.nativeId,
      AA_PI_SOURCE_REVISION: history.revision,
      AA_PI_WRITE_STATE: stateFile,
    }, piDialect(dialectState))
    let inner: AcpRuntimeSession
    try {
      // The generic engine uses the locator as the cwd of session/load|resume.
      inner = await handle.open({ kind: 'existing', ref: { nativeSessionId: this.native, locator: history.cwd } }, this.innerOptions())
      const reported = dialectState.sessionFiles.get(this.native)
      if (!reported || !(await samePath(reported, history.path))) fail('pi_source_mismatch', '恢复返回的原生历史位置不匹配，已停止执行。')
    } catch (error) {
      await handle.stop().catch(() => undefined)
      throw classifyOpen(error)
    }
    const changed = this.dormantRevision !== undefined && this.dormantRevision !== history.revision
    this.dormantRevision = undefined
    if (changed) this.resetHistory(history)
    return this.attach({ handle, inner, dialect: dialectState, pinned: { path: history.path, stateFile }, pump: Promise.resolve() })
  }

  private attach(active: Active): Active {
    const next: Active = { ...active, pump: this.pump(active.inner) }
    this.active = next
    this.innerConfig = active.inner.configOptions
    this.lastCapabilities = active.inner.capabilities.items
    this.host.observe(this.capabilities.items, this.configOptions)
    return next
  }

  private async lock(path: string): Promise<() => Promise<void>> {
    try {
      return await fileLock(join(this.host.lockDir, `${acpFingerprint(path)}.lock`), { timeoutMs: 0 })
    } catch {
      fail('pi_source_busy', '另一 AA 执行实例正在使用此原生会话。')
    }
  }

  // ------------------------------------------------------------------------------------------
  // Dormancy and wakeup
  // ------------------------------------------------------------------------------------------

  private watchIdle(): void {
    if (this.host.idleMs <= 0) return
    this.idleTimer = setInterval(() => void this.checkIdle(), Math.max(50, Math.min(60_000, Math.floor(this.host.idleMs / 4))))
    this.idleTimer.unref?.()
  }

  /** Stops the process after enough idle time with no turn or pending interaction (the session stays open). */
  async checkIdle(now = Date.now()): Promise<boolean> {
    if (this.state !== 'active' || this.active === undefined || this.waking !== undefined || this.busy) return false
    if (now - this.lastActivity < this.host.idleMs) return false
    await this.retire()
    return true
  }

  private async retire(): Promise<void> {
    const active = this.active
    if (!active) return
    this.retiring = true
    try {
      this.file ??= active.dialect.sessionFiles.get(this.native) ?? undefined
      await active.inner.close().catch(() => undefined)
      await active.handle.stop().catch(() => undefined)
      await active.pump
      this.active = undefined
      this.finishOpenTurn()
      if (this.state === 'active') this.state = 'dormant'
      await this.releaseLock?.()
      this.releaseLock = undefined
      try {
        this.dormantRevision = this.file === undefined ? undefined : (await this.host.index.read(this.file)).revision
      } catch {
        this.dormantRevision = undefined
      }
    } finally {
      this.retiring = false
    }
  }

  /** Returns a live process; when dormant, restarts it from the latest native file. */
  private async awake(): Promise<Active> {
    if (this.state === 'closed') fail('session_closed', 'session is closed')
    if (this.active) return this.active
    this.waking ??= (async () => {
      try {
        if (this.file === undefined || !(await exists(this.file))) return await this.restartEmpty()
        return await this.activate()
      } finally {
        this.waking = undefined
      }
    })()
    const active = await this.waking
    if (this.state === 'dormant') this.state = 'active'
    return active
  }

  /** A new session went dormant before writing its native file: nothing to resume, so a new native session takes over. */
  private async restartEmpty(): Promise<Active> {
    const dialectState = piDialectState()
    const handle = this.host.spawn({}, piDialect(dialectState))
    let inner: AcpRuntimeSession
    try {
      inner = await handle.open({ kind: 'new', spec: { cwd: this.cwd } }, this.innerOptions())
    } catch (error) {
      await handle.stop().catch(() => undefined)
      throw classifyOpen(error)
    }
    // The native ID changed: record it in the alias table (continue only after the write); externally it is still the
    // original ID.
    const previous = this.native
    this.native = inner.nativeSessionId
    try {
      await this.host.aliases.record(previous, this.native)
    } catch (error) {
      this.native = previous
      await inner.close().catch(() => undefined)
      await handle.stop().catch(() => undefined)
      throw new RuntimeFailure({ code: 'pi_resume_failed', message: `无法记录 Pi 会话身份：${error instanceof Error ? error.message : String(error)}` })
    }
    this.file = dialectState.sessionFiles.get(this.native) ?? undefined
    await this.host.permissions.set(this.native, this.permission)
    await this.setPlanMode(this.planMode)
    return this.attach({ handle, inner, dialect: dialectState, pump: Promise.resolve() })
  }

  /** The native file changed outside AA: replay the full history with the history ID rules (the same record keeps its ID). */
  private resetHistory(history: PiHistory): void {
    const revision = history.revision
    this.events.push({ type: 'history.reset', phase: 'begin', revision })
    for (const event of this.historyEvents(history, this.sessionId)) this.events.push(event)
    this.events.push({ type: 'history.reset', phase: 'commit', revision })
  }

  private historyEvents(history: PiHistory, conversationId?: string): RuntimeEvent[] {
    return piHistoryEvents(piTimeline(history, this.sessionId, 'pi', conversationId))
  }

  /** With a pinned native file, checks that no other writer exists before sending new input. */
  private async checkSource(active: Active): Promise<void> {
    const pinned = active.pinned
    if (!pinned) return
    const consistent = async (): Promise<boolean> => {
      let state: { revision?: unknown; conflict?: unknown }
      try {
        state = JSON.parse(await readFile(pinned.stateFile, 'utf8')) as typeof state
      } catch {
        return false
      }
      const history = await this.host.index.read(pinned.path)
      return state.conflict !== true && state.revision === history.revision && history.nativeId === this.native
    }
    if (await consistent()) return
    // Our own write and the atomic replacement of the write verification file may straddle this read.
    await new Promise(resolve => setTimeout(resolve, 50))
    if (await consistent()) return
    // Another writer (pi in a terminal) continued the session: stop the process and sync the latest history; the next
    // input builds on the new content.
    await this.retire()
    try {
      if (this.file !== undefined) this.resetHistory(await this.host.index.read(this.file))
      this.dormantRevision = undefined
    } catch {
      // If it cannot be read, check again at the next wakeup
    }
    fail('pi_source_conflict', '原生历史在 AA 之外有新内容，已同步最新历史；请确认终端里的 pi 已退出后重新发送。')
  }

  // ------------------------------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------------------------------

  private async pump(inner: AcpRuntimeSession): Promise<void> {
    for await (const event of inner.events) {
      this.touch()
      const forwarded = this.translate(event)
      if (forwarded === undefined) continue
      this.events.push(forwarded)
      if (forwarded.type === 'notice' && asRecord(forwarded.data).code === GUARD_FAILED) void this.guardFailed()
    }
  }

  private translate(event: RuntimeEvent): RuntimeEvent | undefined {
    switch (event.type) {
      case 'tool.started':
      case 'tool.updated':
        this.toolItems.set(event.toolCallId, event.itemId)
        return event
      case 'interaction.opened':
        return this.interactionOpened(event)
      case 'interaction.resolved':
        this.synthetic.delete(event.interactionId)
        return event
      case 'config.updated':
        this.innerConfig = event.options
        this.host.observe(this.capabilities.items, this.configOptions)
        return { ...event, options: this.configOptions }
      case 'planning.mode_changed':
        // After the plan is approved the guard removes the marker and reports normal.
        this.planMode = event.mode === 'plan'
        this.events.push({ type: 'config.updated', options: this.configOptions })
        return event
      case 'commands.updated':
        this.commands = event.commands.map(command => ({ name: command.name, ...(command.description !== undefined ? { description: command.description } : {}) }))
        return event
      case 'capabilities.changed':
        this.lastCapabilities = event.capabilities.items
        this.capabilityRevision += 1
        return { ...event, capabilities: this.capabilities }
      case 'turn.started':
        this.openTurn = event.turnId
        return event
      case 'turn.ended':
        this.openTurn = undefined
        if (event.reason === 'failed' && this.planDismissed && /aborted/i.test(event.error?.message ?? '')) {
          this.planDismissed = false
          return { type: 'turn.ended', turnId: event.turnId, reason: 'cancelled' }
        }
        this.planDismissed = false
        // Model error: put the reason on the Timeline as an error notice (history has a matching item for the same
        // failure, see pi-history.ts).
        if (event.reason === 'failed' && event.error?.details?.assistantError === true) {
          this.events.push({
            type: 'notice', turnId: event.turnId, itemId: acpFingerprint([this.sessionId, 'pi-turn-error', event.turnId]), level: 'error', kind: 'error',
            text: event.error.message, data: { code: event.error.code, ...(event.error.details ?? {}) },
          })
        }
        return event
      case 'message.completed':
        return event.role === 'user' ? withTimelineAttachments(event) : event
      case 'session.lost':
        if (this.retiring) return undefined
        void this.lost()
        return event
      default:
        return event
    }
  }

  /** Rewrites the guard's form requests into AA approvals and plan reviews. */
  private interactionOpened(event: Extract<RuntimeEvent, { type: 'interaction.opened' }>): RuntimeEvent {
    if (event.kind !== 'form') return event
    if (event.title.startsWith(TOOL_PERMISSION_PREFIX)) {
      let tool: { id?: unknown; name?: unknown; input?: unknown } = {}
      try {
        tool = JSON.parse(event.title.slice(TOOL_PERMISSION_PREFIX.length)) as typeof tool
      } catch {
        // Approval is still required when the request cannot be parsed; no path other than an explicit answer lets it through
      }
      this.synthetic.set(event.interactionId, { kind: 'tool' })
      const itemId = typeof tool.id === 'string' ? this.toolItems.get(tool.id) : undefined
      const name = typeof tool.name === 'string' ? tool.name : 'tool'
      return {
        type: 'interaction.opened',
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        interactionId: event.interactionId,
        kind: 'approval',
        title: name,
        body: describeInput(name, tool.input),
        ...(itemId !== undefined ? { itemId } : {}),
        options: [{ id: 'allow', label: '允许本次', kind: 'allow_once' }, { id: 'deny', label: '拒绝', kind: 'reject_once' }],
      }
    }
    if (event.title.startsWith(PLAN_REVIEW_PREFIX)) {
      const toolCallId = event.title.slice(PLAN_REVIEW_PREFIX.length)
      const markdown = asRecord(asRecord(asRecord(event.schema?.properties).value)).description
      this.synthetic.set(event.interactionId, { kind: 'plan' })
      if (!toolCallId || typeof markdown !== 'string' || markdown.trim() === '') {
        // No plan text to review: answer "not now" so the turn does not hang.
        void this.respond(event.interactionId, { kind: 'plan_review', action: 'dismiss' })
        return { type: 'notice', ...(event.turnId !== undefined ? { turnId: event.turnId } : {}), itemId: `pi-plan:${event.interactionId}`, level: 'warning', kind: 'warning', text: 'Pi 未提供有效的计划正文。' }
      }
      return {
        type: 'interaction.opened',
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        interactionId: event.interactionId,
        kind: 'plan_review',
        title: 'Plan',
        plan: {
          planId: `plan:${toolCallId}`, markdown, title: 'Plan', revision: 1, contentHash: `sha256:${sha256(markdown)}`,
          contentState: 'ready', createdAt: null, sourceTurnId: event.turnId ?? null,
        },
      }
    }
    return event
  }

  private async guardFailed(): Promise<void> {
    // A guard failure stops execution: interrupt the run, wait for it to end (at most 5 seconds), then stop the
    // process; the next input reloads the guard.
    const inner = this.active?.inner
    await inner?.cancel().catch(() => undefined)
    for (let waited = 0; inner?.busy === true && waited < 5000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50))
    await this.retire()
  }

  private async lost(): Promise<void> {
    // The process exited unexpectedly: the generic session has already ended the turn and reported session.lost; the
    // session must be opened again.
    this.state = 'closed'
    this.active = undefined
    this.stopIdle()
    await this.releaseLock?.()
    this.releaseLock = undefined
    this.events.close()
    this.host.released(this)
  }

  private touch(): void {
    this.lastActivity = Date.now()
  }

  // ------------------------------------------------------------------------------------------
  // RuntimeSession
  // ------------------------------------------------------------------------------------------

  async prompt(input: PromptInput, delivery: DeliveryRef): Promise<PromptAcceptance> {
    this.touch()
    if (this.state === 'closed') return { outcome: 'rejected', error: { code: 'session_closed', message: 'session is closed' } }
    let active: Active
    try {
      active = await this.awake()
      await this.checkSource(active)
      // Pi's native /bash bypasses the tool guard: check it with the same rules before sending.
      const bash = bashCommand(input.text)
      if (bash !== undefined && !(await this.authorizeBash(bash))) fail('permission_denied', '当前权限或用户审批未允许此命令。')
    } catch (error) {
      return { outcome: 'rejected', error: runtimeError(error) }
    }
    this.planDismissed = false
    this.touch()
    return active.inner.prompt(input, delivery)
  }

  readonly steer = async (input: PromptInput, delivery: DeliveryRef): Promise<SteerResult> => {
    this.touch()
    // A dormant session has no turn to steer into, and Pi does not start a new turn by itself (`_session/steering`
    // answers promptRequired).
    const inner = this.active?.inner
    if (inner?.steer === undefined) return { outcome: 'prompt_required' }
    return inner.steer(input, delivery)
  }

  async cancel(expectedTurnId?: string): Promise<void> {
    this.touch()
    for (const [id, pending] of this.synthetic) {
      if (pending.kind !== 'bash') continue
      this.synthetic.delete(id)
      pending.resolve(false)
      this.events.push({ type: 'interaction.resolved', interactionId: id, resolution: 'expired' })
    }
    await this.active?.inner.cancel(expectedTurnId)
  }

  async respond(interactionId: string, answer: InteractionAnswer): Promise<void | InteractionRefusal> {
    this.touch()
    const pending = this.synthetic.get(interactionId)
    const inner = this.active?.inner
    if (pending?.kind === 'bash') {
      this.synthetic.delete(interactionId)
      pending.resolve(answer.kind === 'option' && answer.optionId === 'allow')
      this.events.push({ type: 'interaction.resolved', interactionId, resolution: 'answered', answeredBy: 'self' })
      return
    }
    if (inner === undefined) invalidParams(`no pending interaction ${interactionId}`)
    if (pending?.kind === 'tool') {
      if (answer.kind === 'cancelled') return inner.respond(interactionId, answer)
      const allowed = answer.kind === 'option' && answer.optionId === 'allow'
      return inner.respond(interactionId, { kind: 'form', action: 'accept', values: { confirmed: allowed } })
    }
    if (pending?.kind === 'plan') {
      if (answer.kind === 'plan_review' && answer.action === 'approve') return inner.respond(interactionId, { kind: 'form', action: 'accept', values: { value: 'approve' } })
      if (answer.kind === 'plan_review' && answer.action === 'revise') {
        return inner.respond(interactionId, { kind: 'form', action: 'accept', values: { value: `revise\n${answer.feedback ?? ''}` } })
      }
      this.planDismissed = true
      return inner.respond(interactionId, { kind: 'form', action: 'cancel' })
    }
    return inner.respond(interactionId, answer)
  }

  async configure(change: ConfigChange): Promise<ConfigResult> {
    this.touch()
    const option = findOption(this.configOptions, change.optionId)
    if (option?.id === PERMISSION_OPTION) {
      if (typeof change.value !== 'string' || !(PERMISSIONS as readonly string[]).includes(change.value)) invalidParams('权限选项无效。')
      await this.setPermission(change.value as PiPermission)
      this.emitConfig()
      return { options: this.configOptions, appliesFrom: 'now' }
    }
    if (option?.id === PLAN_OPTION) {
      if (change.value !== 'plan' && change.value !== 'normal') invalidParams('Pi 规划模式值无效。')
      await this.setPlanMode(change.value === 'plan')
      this.emitConfig()
      this.events.push({ type: 'planning.mode_changed', mode: this.planMode ? 'plan' : 'normal' })
      // Plan mode takes effect when the next run starts (the guard reads the marker in before_agent_start).
      return { options: this.configOptions, appliesFrom: this.busy ? 'next_turn' : 'now' }
    }
    const active = await this.awake()
    const result = await active.inner.configure(change)
    this.innerConfig = result.options
    this.host.observe(this.capabilities.items, this.configOptions)
    return { ...result, options: this.configOptions }
  }

  async command(name: string, args?: string): Promise<CommandResult> {
    this.touch()
    let active: Active
    try {
      active = await this.awake()
      await this.checkSource(active)
      if (name === 'bash' && !(await this.authorizeBash((args ?? '').trim()))) fail('permission_denied', '当前权限或用户审批未允许此命令。')
    } catch (error) {
      return { ok: false, error: runtimeError(error) }
    }
    return active.inner.command(name, args)
  }

  /** `authentication.status` (where Pi's model credentials come from) and `resources.get` (its slash commands). */
  async operate(operation: string, _values: JsonObject): Promise<JsonObject> {
    this.touch()
    if (operation === 'authentication.status') return { message: '模型认证来自此 Pi 执行来源的原生配置与环境。' }
    if (operation === 'resources.get') return { commands: this.commands.map(command => ({ ...command })) }
    fail('unsupported_operation', 'Pi 尚未提供此操作。')
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    this.state = 'closed'
    await this.shutdown()
    this.events.close()
    this.host.released(this)
  }

  private async shutdown(): Promise<void> {
    this.stopIdle()
    this.expireSynthetic()
    const active = this.active
    this.retiring = true
    try {
      if (active) {
        await active.inner.close().catch(() => undefined)
        await active.handle.stop().catch(() => undefined)
        await active.pump
      }
      this.finishOpenTurn()
    } finally {
      this.retiring = false
      this.active = undefined
    }
    await this.releaseLock?.()
    this.releaseLock = undefined
  }

  /** Turns and interactions still open when the process stops: emit their end events so no turn is left dangling on the port. */
  private finishOpenTurn(): void {
    this.expireSynthetic()
    const turnId = this.openTurn
    if (turnId === undefined) return
    this.openTurn = undefined
    this.events.push({ type: 'turn.ended', turnId, reason: 'failed', error: { code: 'pi_process_stopped', message: 'Pi 进程已停止，本轮未完成。' } })
  }

  private expireSynthetic(): void {
    for (const [id, pending] of [...this.synthetic]) {
      this.synthetic.delete(id)
      if (pending.kind === 'bash') pending.resolve(false)
      this.events.push({ type: 'interaction.resolved', interactionId: id, resolution: 'expired' })
    }
  }

  private stopIdle(): void {
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    this.idleTimer = undefined
  }

  // ------------------------------------------------------------------------------------------
  // Synthesized config options: permission (file read by the guard), plan mode (marker file)
  // ------------------------------------------------------------------------------------------

  private permissionOption(): ConfigOption {
    return {
      id: PERMISSION_OPTION, name: '权限', category: 'permission', type: 'select', currentValue: this.permission,
      values: PERMISSIONS.map(value => ({ value, name: PERMISSION_LABELS[value] })),
    }
  }

  private planOption(): ConfigOption {
    return {
      id: PLAN_OPTION, name: 'Plan', category: 'mode', type: 'select', currentValue: this.planMode ? 'plan' : 'normal',
      values: [{ value: 'normal', name: 'Normal' }, { value: 'plan', name: 'Plan' }],
    }
  }

  private emitConfig(): void {
    this.host.observe(this.capabilities.items, this.configOptions)
    this.events.push({ type: 'config.updated', options: this.configOptions })
  }

  private async setPermission(value: PiPermission): Promise<void> {
    await this.host.permissions.set(this.native, value)
    this.permission = value
  }

  private planMarker(): string {
    return join(this.host.planningDir, sha256(this.native))
  }

  private async planMarkerExists(): Promise<boolean> {
    return exists(this.planMarker())
  }

  private async setPlanMode(plan: boolean): Promise<void> {
    if (plan) {
      await mkdir(this.host.planningDir, { recursive: true, mode: 0o700 })
      await writeFile(this.planMarker(), '', { mode: 0o600 })
    } else {
      await rm(this.planMarker(), { force: true })
    }
    this.planMode = plan
  }

  /** `/bash` authorization: always refused in plan mode and read-only; otherwise asks the user for approval. */
  private async authorizeBash(command: string): Promise<boolean> {
    if (this.planMode || (await this.planMarkerExists()) || this.permission === 'readonly') return false
    const interactionId = `interaction_${randomUUID()}`
    const answer = new Promise<boolean>(resolve => this.synthetic.set(interactionId, { kind: 'bash', resolve }))
    this.events.push({
      type: 'interaction.opened', interactionId, kind: 'approval', title: 'bash', body: command,
      options: [{ id: 'allow', label: '允许本次', kind: 'allow_once' }, { id: 'deny', label: '拒绝', kind: 'reject_once' }],
    })
    return answer
  }
}

/** User message sent by AA: attachments with a platform identity are also given in Timeline shape (matching what history reads back). */
function withTimelineAttachments(event: Extract<RuntimeEvent, { type: 'message.completed' }>): RuntimeEvent {
  if (event.timelineAttachments !== undefined || event.attachments === undefined) return event
  const infos = event.attachments.flatMap(attachment => (attachment.info !== undefined ? [attachment.info] : []))
  return infos.length > 0 ? { ...event, timelineAttachments: infos } : event
}

/** The command part of `/bash <command>`; undefined when it is not /bash. */
export function bashCommand(text: string): string | undefined {
  const trimmed = text.trimStart()
  const head = trimmed.split(/\s+/, 1)[0]
  return head === '/bash' ? trimmed.slice(5).trim() : undefined
}

function describeInput(name: string, input: unknown): string {
  const record = asRecord(input)
  if (name === 'bash' && typeof record.command === 'string') return record.command
  try {
    const text = JSON.stringify(input ?? {}, null, 2)
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
  } catch {
    return ''
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function samePath(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return false
  }
}

/** Error classification while opening (open / resume phases). */
export function classifyOpen(error: unknown): RuntimeFailure {
  if (error instanceof RuntimeFailure) return error
  const problem: RuntimeError | undefined = piDialect().classifyError?.(error)
  return new RuntimeFailure(problem ?? runtimeError(error, 'pi_open_failed'))
}

