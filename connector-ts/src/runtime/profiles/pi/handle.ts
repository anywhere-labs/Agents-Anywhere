// Pi 的 RuntimeHandle：原生会话目录与只读历史来自原生历史伴随层；每个 AA 会话一个 Pi 进程（PiRuntimeSession）。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/native_runtime.py（浏览部分）与 runtime.py
// （受管环境在后台准备，不阻塞启动）。

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  Capability,
  Catalogs,
  ConfigOption,
  HistoryWindow,
  NativeHistoryPage,
  NativeSessionPage,
  NativeSessionRef,
  OpenOptions,
  OpenTarget,
  RuntimeCapabilities,
  RuntimeHandle,
  RuntimeHandleEvent,
} from '../../../application/ports/runtime-session.js'
import { piNativeSessionId } from '../../../domain/identity/index.js'
import type { AcpDialect } from '../../acp/dialect.js'
import { RuntimeFailure } from '../../acp/errors.js'
import { AcpRuntimeHandle, catalogsFromConfig, processConnection, type AcpConnection } from '../../acp/handle.js'
import { EventQueue } from '../../acp/queue.js'
import { runtimeError } from '../../acp/session.js'
import { piHistoryPage, piTimeline, PiNativeIndex } from '../../companions/native-history/index.js'
import { agentEnvironment } from '../../supervisor/environment.js'
import type { LocalLaunch } from '../launch.js'
import { PI_PERMISSION_OPTIONS } from './definition.js'
import { historyDirectories } from './installation.js'
import { PiSessionAliases } from './aliases.js'
import type { PiLayout } from './launch.js'
import { PermissionStore, PiRuntimeSession, type PiSessionHost } from './session.js'
import { updateDefaultModel, type PiSettings } from './settings.js'

/** 每个会话的进程空闲这么久就停掉（会话休眠，下次输入自动拉起）。 */
export const DEFAULT_SESSION_IDLE_MS = 10 * 60_000
/** 交给通用进程池的空闲时间：Pi 会话自己管空闲，池子不要先动手。 */
const POOL_IDLE_MS = 2 ** 31 - 1

/** 起一个 Pi 进程的连接（测试替换成内存连接）。 */
export type PiConnect = (environment: Readonly<Record<string, string>>, dialect: AcpDialect) => Promise<AcpConnection>

export interface PiHandleOptions {
  readonly instanceId: string
  readonly settings: PiSettings
  readonly layout: PiLayout
  /** 每次拉起进程前的启动准备（会复核安装、补丁、执行来源）。 */
  readonly launch: () => Promise<LocalLaunch>
  readonly connect?: PiConnect
  readonly idleMs?: number
  /** 原生会话锁目录（缺省 ~/.cache/agents-anywhere/pi-native-locks，与同机其他 Connector 共用）。 */
  readonly lockDir?: string
  readonly onStderr?: (line: string) => void
  /** 受管环境在后台先准备一次（下载 Node / npm 包可能很久），状态经 events 报告。 */
  readonly warmUp?: boolean
  readonly env?: NodeJS.ProcessEnv
}

/** 还没起过进程时的能力：Pi 一定有的那些（真正的值在第一个会话握手后更新）。 */
const INITIAL_CAPABILITIES: readonly Capability[] = [
  { id: 'session.send_message', supported: true },
  { id: 'session.interrupt', supported: true },
  { id: 'session.interaction.approval', supported: true },
  { id: 'session.configuration.read', supported: true },
  { id: 'session.configuration.update', supported: true },
  { id: 'session.list', supported: true },
  { id: 'session.history.native', supported: true },
  { id: 'catalog.permission', supported: true },
  { id: 'session.planning', supported: true },
  { id: 'session.plan_document', supported: true },
  { id: 'session.plan_review', supported: true },
]

export class PiRuntimeHandle implements RuntimeHandle {
  readonly type = 'pi'
  readonly instanceId: string
  readonly events = new EventQueue<RuntimeHandleEvent>()
  readonly index: PiNativeIndex
  readonly aliases: PiSessionAliases
  private readonly sessions = new Set<PiRuntimeSession>()
  private readonly permissions: PermissionStore
  private capabilityItems: readonly Capability[] = INITIAL_CAPABILITIES
  private revision = 1
  private lastConfig: readonly ConfigOption[] = []
  private stopped = false
  private ready: Promise<void> | undefined

  constructor(private readonly options: PiHandleOptions) {
    this.instanceId = options.instanceId
    const agentDir = options.layout.agentDir
    this.aliases = new PiSessionAliases(join(options.layout.root, 'pi-session-aliases.json'))
    this.index = new PiNativeIndex(() => [
      ...historyDirectories(options.settings as unknown as Parameters<typeof historyDirectories>[0], agentDir),
      ...(options.layout.sessionDir !== undefined ? [options.layout.sessionDir] : []),
    ], this.aliases)
    this.permissions = new PermissionStore(options.layout.permissionFile)
    if (options.warmUp) this.ready = this.warmUp()
  }

  private async warmUp(): Promise<void> {
    this.events.push({ type: 'status', status: 'starting' })
    try {
      await this.options.launch()
      this.events.push({ type: 'status', status: 'ready' })
    } catch (error) {
      const failure = error instanceof RuntimeFailure ? error.error : { code: 'pi_environment_failed', message: 'Pi 运行环境准备失败，请检查配置和网络后重试。' }
      this.events.push({ type: 'status', status: 'degraded', error: failure })
    }
  }

  capabilities(): RuntimeCapabilities {
    return { revision: this.revision, items: this.capabilityItems }
  }

  async catalogs(): Promise<Catalogs> {
    const fromConfig = catalogsFromConfig('pi', this.lastConfig)
    return {
      ...fromConfig,
      permissions: {
        runtime: 'pi',
        revision: 1,
        permissions: PI_PERMISSION_OPTIONS.map(([value, title]) => ({ id: value, displayName: title, description: null, default: value === 'ask', selectionId: value, metadata: {} })),
      },
    }
  }

  /** 只读盘点原生 JSONL；不启动 Pi。 */
  listNativeSessions(cursor?: string): Promise<NativeSessionPage> {
    return this.index.list(cursor)
  }

  /**
   * 只读历史：直接解析原生文件，不 resume、不抢锁、不写源文件。条目 ID 用 v2 浏览原生会话时的平台会话 ID
   * （`pi_native_<…>`，domain/identity `piNativeSessionId`）计算；会话换过原生 ID 时用对外的（最初的）ID。
   */
  async readNativeHistory(ref: NativeSessionRef, window: HistoryWindow): Promise<NativeHistoryPage> {
    const source = await this.index.find(ref)
    const history = await this.index.read(source.path)
    return piHistoryPage(piTimeline(history, piNativeSessionId(this.instanceId, history.path, source.externalSessionId)), window)
  }

  async open(target: OpenTarget, options: OpenOptions): Promise<PiRuntimeSession> {
    if (this.stopped) throw new RuntimeFailure({ code: 'runtime_stopped', message: 'Pi 实例已停止。' })
    await this.ready
    const session = target.kind === 'new'
      ? await PiRuntimeSession.open(this.host(), options.sessionId, { kind: 'new', spec: target.spec })
      : await PiRuntimeSession.open(this.host(), options.sessionId, { kind: 'existing', source: await this.index.find(target.ref), replay: options.replay })
    this.sessions.add(session)
    return session
  }

  async stop(): Promise<void> {
    this.stopped = true
    await Promise.all([...this.sessions].map(session => session.close().catch(() => undefined)))
    this.events.push({ type: 'status', status: 'stopped' })
    this.events.close()
  }

  /**
   * 只改了网关的默认模型时，受管环境不必重启：改私有 settings.json，之后新开的会话（各自的 Pi 进程启动时读它）
   * 用新模型，已有会话保留自己的模型（v2 `apply_model_setting`）。不是受管环境、或环境还没准备好时返回 false。
   */
  async applyDefaultModel(model: string | undefined): Promise<boolean> {
    if (!this.options.layout.managed) return false
    try {
      await updateDefaultModel(this.options.layout.agentDir, model)
      return true
    } catch {
      return false
    }
  }

  /** 会话数（测试与诊断）。 */
  get openSessions(): number {
    return this.sessions.size
  }

  private host(): PiSessionHost {
    const options = this.options
    return {
      instanceId: this.instanceId,
      index: this.index,
      permissions: this.permissions,
      aliases: this.aliases,
      planningDir: options.layout.planningDir,
      stateDir: options.layout.root,
      lockDir: options.lockDir ?? join(homedir(), '.cache/agents-anywhere/pi-native-locks'),
      idleMs: options.idleMs ?? DEFAULT_SESSION_IDLE_MS,
      spawn: (environment, dialect) => new AcpRuntimeHandle({
        type: 'pi',
        instanceId: this.instanceId,
        dialect,
        connect: () => this.connect(environment, dialect),
        idleMs: POOL_IDLE_MS,
        permissionOptions: PI_PERMISSION_OPTIONS,
      }),
      observe: (capabilities, config) => {
        if (JSON.stringify(capabilities) !== JSON.stringify(this.capabilityItems)) {
          this.capabilityItems = capabilities
          this.revision += 1
          this.events.push({ type: 'capabilities.changed', capabilities: this.capabilities() })
        }
        if (JSON.stringify(config) !== JSON.stringify(this.lastConfig)) {
          this.lastConfig = config
          void this.catalogs().then(catalogs => this.events.push({ type: 'catalogs.changed', catalogs }))
        }
      },
      released: session => {
        this.sessions.delete(session)
      },
    }
  }

  private async connect(environment: Readonly<Record<string, string>>, dialect: AcpDialect): Promise<AcpConnection> {
    if (this.options.connect) return this.options.connect(environment, dialect)
    let launch: LocalLaunch
    try {
      launch = await this.options.launch()
    } catch (error) {
      throw error instanceof RuntimeFailure ? error : new RuntimeFailure(runtimeError(error, 'pi_environment_failed'))
    }
    const onStderr = this.options.onStderr
    await mkdir(this.options.layout.root, { recursive: true, mode: 0o700 })
    return processConnection(
      {
        command: launch.command,
        args: launch.args,
        cwd: this.options.layout.root,
        env: agentEnvironment({ ...launch.environment, ...environment }, this.options.env ? { base: this.options.env } : {}),
      },
      dialect,
      onStderr ? { onStderr } : {},
    )()
  }
}
