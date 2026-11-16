// Pi 会话：一个 AA 会话一个 Pi 进程，包着通用 ACP 会话（runtime/acp/session.ts）。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/dialect.py（审批表单、计划审阅、合成的
// 权限 / 计划配置项、`/bash` 授权）与 native_runtime.py（交接：锁、写入校验、来源核对）。
//
// 相对 v2 改掉的三个体验债（04-connector.md §5.4）：
// - 进程按会话空闲回收：空闲 `idleMs` 后停掉进程，会话进入休眠；下一次 prompt / configure / command 自动带着
//   最新的原生文件重新拉起，端口上看不出断开（不发 session.lost）。
// - Connector 重启后不再要求手动「恢复」：open(existing) 直接以只读核对过的原生文件拉起进程；v2 要求的
//   「确认 CLI 已退出」改为由 SDK bridge 的写入校验兜底（别的写者改过文件，AA 拒绝继续写并同步最新历史）。
// - 单轮没有硬超时：通用引擎的 session/prompt 不设超时，回合由 Runtime 的结束或中断驱动。

import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  Capability,
  CommandResult,
  ConfigChange,
  ConfigOption,
  ConfigResult,
  DeliveryRef,
  InteractionAnswer,
  NewSessionSpec,
  PlanningPort,
  PromptAcceptance,
  PromptInput,
  RuntimeError,
  RuntimeEvent,
  RuntimeSession,
  SessionCapabilities,
  SteerResult,
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
  { id: 'session.planning', supported: true },
  { id: 'session.plan_document', supported: true },
  { id: 'session.plan_review', supported: true },
]

const PERMISSION_LABELS: Readonly<Record<PiPermission, string>> = { ask: '写入与命令审批', ask_all: '全部工具审批', readonly: '只读' }

/** 按原生会话 ID 记的权限模式（守卫在每次工具调用时读这个文件）。同一实例内串行读改写。 */
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

/** Pi 会话从所属实例拿到的东西。 */
export interface PiSessionHost {
  readonly instanceId: string
  readonly index: PiNativeIndex
  readonly permissions: PermissionStore
  /** 原生会话 ID 别名：会话换了原生 ID 时记下，对外一直报告最初的 ID。 */
  readonly aliases: PiSessionAliases
  /** 计划模式标记目录（守卫读同一个目录）。 */
  readonly planningDir: string
  /** 写入校验文件（SDK bridge 每次写原生文件后报告摘要）所在目录。 */
  readonly stateDir: string
  /** 同一原生文件只允许一个 AA 进程写（跨 Connector 实例）。 */
  readonly lockDir: string
  readonly idleMs: number
  /** 一个新的单进程 handle；进程带着会话专属的环境变量，在第一次 open 时启动。 */
  spawn(environment: Readonly<Record<string, string>>, dialect: AcpDialect): AcpRuntimeHandle
  /** 会话拿到了新的能力与配置（实例的目录与能力跟着更新）。 */
  observe(capabilities: readonly Capability[], config: readonly ConfigOption[]): void
  released(session: PiRuntimeSession): void
}

interface Active {
  readonly handle: AcpRuntimeHandle
  readonly inner: AcpRuntimeSession
  readonly dialect: PiDialectState
  /** 以原生文件拉起时：钉住的文件、写入校验文件。 */
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
  /** 当前 Pi 进程里的真实原生 ID（进程、锁、权限、计划标记、写入校验都按它）。 */
  private native = ''
  /** 对外报告的原生 ID：最初的那个，之后换了原生会话也不变（aliases.ts）。 */
  private external = ''
  private cwd = ''
  /** 已知的原生文件（新会话在 Pi 第一次写入后才有内容）。 */
  private file: string | undefined
  private active: Active | undefined
  private waking: Promise<Active> | undefined
  private state: 'starting' | 'active' | 'dormant' | 'closed' = 'starting'
  /** 进程即将按计划停下（休眠、关闭）：这时的 session.lost 不往外报。 */
  private retiring = false
  /** 休眠时原生文件的摘要：醒来发现变了，说明别的写者续写过，同步一次完整历史。 */
  private dormantRevision: string | undefined
  private releaseLock: (() => Promise<void>) | undefined
  private innerConfig: readonly ConfigOption[] = []
  private permission: PiPermission = 'ask'
  private planMode = false
  private lastCapabilities: readonly Capability[] = []
  private capabilityRevision = 1
  private readonly toolItems = new Map<string, string>()
  private readonly synthetic = new Map<string, Synthetic>()
  /** 当前回合里用户暂不执行计划：Pi 以中断结束这一轮，回合算取消而不是失败（v2 `prompt_cancelled`）。 */
  private planDismissed = false
  /** 正在进行的回合（通用会话报告的）：进程被提前停掉时由这里补上回合结束。 */
  private openTurn: string | undefined
  private lastActivity = Date.now()
  private idleTimer: ReturnType<typeof setInterval> | undefined

  private constructor(readonly sessionId: string, private readonly host: PiSessionHost) {
    this.planning = {
      setMode: async mode => {
        await this.configure({ optionId: PLAN_OPTION, value: mode })
      },
      current: async () => ({ mode: this.planMode ? 'plan' : 'normal' }),
    }
  }

  /** 新建或附着一个会话；失败时已经释放进程与锁。 */
  static async open(host: PiSessionHost, sessionId: string, target: PiOpenNew | PiOpenExisting): Promise<PiRuntimeSession> {
    const session = new PiRuntimeSession(sessionId, host)
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
    return { revision: this.capabilityRevision, items: [...items.filter(item => !PLAN_CAPABILITIES.some(plan => plan.id === item.id)), ...PLAN_CAPABILITIES] }
  }

  get configOptions(): readonly ConfigOption[] {
    return [...this.innerConfig, this.planOption(), this.permissionOption()]
  }

  get busy(): boolean {
    return this.active?.inner.busy === true || this.synthetic.size > 0
  }

  // ------------------------------------------------------------------------------------------
  // 打开
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
      inner = await handle.open({ kind: 'new', spec: { ...spec, selections } }, { sessionId: this.sessionId, replay: 'none' })
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

  /** 以原生文件拉起 Pi 进程并 resume（交接、Connector 重启后、休眠醒来都走这里）。 */
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
      // 通用引擎把 locator 当作 session/load|resume 的 cwd。
      inner = await handle.open({ kind: 'existing', ref: { nativeSessionId: this.native, locator: history.cwd } }, { sessionId: this.sessionId, replay: 'none' })
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
  // 休眠与唤醒
  // ------------------------------------------------------------------------------------------

  private watchIdle(): void {
    if (this.host.idleMs <= 0) return
    this.idleTimer = setInterval(() => void this.checkIdle(), Math.max(50, Math.min(60_000, Math.floor(this.host.idleMs / 4))))
    this.idleTimer.unref?.()
  }

  /** 没有回合、待答交互时空闲够久就停掉进程（会话不关闭）。 */
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

  /** 拿到活着的进程；休眠中就带着最新原生文件重新拉起。 */
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

  /** 新会话还没写过原生文件就休眠了：没有可续的内容，开一个新的原生会话接上。 */
  private async restartEmpty(): Promise<Active> {
    const dialectState = piDialectState()
    const handle = this.host.spawn({}, piDialect(dialectState))
    let inner: AcpRuntimeSession
    try {
      inner = await handle.open({ kind: 'new', spec: { cwd: this.cwd } }, { sessionId: this.sessionId, replay: 'none' })
    } catch (error) {
      await handle.stop().catch(() => undefined)
      throw classifyOpen(error)
    }
    // 原生 ID 换了：记进别名表（写盘后才继续），对外仍是最初的 ID。
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

  /** 原生文件在 AA 之外变了：按 v2 历史规则重放完整历史（同一记录的 ID 不变）。 */
  private resetHistory(history: PiHistory): void {
    const revision = history.revision
    this.events.push({ type: 'history.reset', phase: 'begin', revision })
    for (const event of this.historyEvents(history)) this.events.push(event)
    this.events.push({ type: 'history.reset', phase: 'commit', revision })
  }

  private historyEvents(history: PiHistory): RuntimeEvent[] {
    return piHistoryEvents(piTimeline(history, this.sessionId))
  }

  /** 钉住原生文件时，发出新输入前核对没有别的写者（v2 `_check_source`）。 */
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
    // 自己的写入和写入校验文件的原子替换可能正好跨过这次读取。
    await new Promise(resolve => setTimeout(resolve, 50))
    if (await consistent()) return
    // 别的写者（终端里的 pi）续写过：停掉进程、同步最新历史；下一次输入以新内容为准。
    await this.retire()
    try {
      if (this.file !== undefined) this.resetHistory(await this.host.index.read(this.file))
      this.dormantRevision = undefined
    } catch {
      // 读不到就等下一次唤醒时再核对
    }
    fail('pi_source_conflict', '原生历史在 AA 之外有新内容，已同步最新历史；请确认终端里的 pi 已退出后重新发送。')
  }

  // ------------------------------------------------------------------------------------------
  // 事件
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
        // 守卫在计划通过后删掉标记并报告 normal。
        this.planMode = event.mode === 'plan'
        this.events.push({ type: 'config.updated', options: this.configOptions })
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
        // 模型报错：把原因作为错误提示放进 Timeline（历史里同一种失败也有一条，见 pi-history.ts）。
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

  /** 守卫的表单请求改写成 AA 的审批与计划审阅（v2 `PiDialect.interaction`、`plan_review`）。 */
  private interactionOpened(event: Extract<RuntimeEvent, { type: 'interaction.opened' }>): RuntimeEvent {
    if (event.kind !== 'form') return event
    if (event.title.startsWith(TOOL_PERMISSION_PREFIX)) {
      let tool: { id?: unknown; name?: unknown; input?: unknown } = {}
      try {
        tool = JSON.parse(event.title.slice(TOOL_PERMISSION_PREFIX.length)) as typeof tool
      } catch {
        // 解析不了也照样要求审批，回答按拒绝处理之外的路径不会放行
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
        // 没有可审阅的正文：按暂不执行回答，不让回合卡住。
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
    // v2：守卫异常即停止执行。中断这一轮，等它结束（最多 5 秒）后停掉进程；下一次输入重新载入守卫。
    const inner = this.active?.inner
    await inner?.cancel().catch(() => undefined)
    for (let waited = 0; inner?.busy === true && waited < 5000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50))
    await this.retire()
  }

  private async lost(): Promise<void> {
    // 进程意外退出：通用会话已经结束回合并报告 session.lost；会话需要重新 open。
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
      // Pi 原生的 /bash 不经工具守卫：在发出前按同样的规则核对。
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
    // 休眠中没有回合可插话；Pi 也不会自己开新回合（`_session/steering` 回 promptRequired）。
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

  async respond(interactionId: string, answer: InteractionAnswer): Promise<void> {
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
      // 计划模式在下一轮开始时生效（守卫在 before_agent_start 读标记）。
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

  /** 进程停掉时还没结束的回合与交接交互：补上结束事件，端口上不留悬空的回合。 */
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
  // 合成配置项：权限（守卫读文件）、计划模式（标记文件）
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

  /** `/bash` 授权：计划模式与只读一律拒绝，否则请用户审批（v2 `authorize_bash`）。 */
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

/** AA 发出的用户消息：带平台身份的附件同时以 Timeline 形状给出（与历史里读回来的一致）。 */
function withTimelineAttachments(event: Extract<RuntimeEvent, { type: 'message.completed' }>): RuntimeEvent {
  if (event.timelineAttachments !== undefined || event.attachments === undefined) return event
  const infos = event.attachments.flatMap(attachment => (attachment.info !== undefined ? [attachment.info] : []))
  return infos.length > 0 ? { ...event, timelineAttachments: infos } : event
}

/** `/bash <command>` 的命令部分；不是 /bash 时 undefined。 */
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

/** 打开时的错误归类（v2 `classify_error` 的 open / resume 阶段）。 */
export function classifyOpen(error: unknown): RuntimeFailure {
  if (error instanceof RuntimeFailure) return error
  const problem: RuntimeError | undefined = piDialect().classifyError?.(error)
  return new RuntimeFailure(problem ?? runtimeError(error, 'pi_open_failed'))
}

