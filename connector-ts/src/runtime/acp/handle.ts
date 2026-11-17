// RuntimeHandle / RuntimeProvider 的通用 ACP 实现：进程池 + ACP 客户端 + 方言。
// 进程监督在 supervisor/，会话引擎在 session.ts；这里负责打开会话、原生会话目录、只读历史与运行时级事件。

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import type {
  Capability,
  Catalogs,
  ConfigOption,
  HistoryItem,
  HistoryWindow,
  NativeHistoryPage,
  NativeSessionPage,
  NativeSessionRef,
  NativeSessionSummary,
  NewSessionSpec,
  OpenOptions,
  OpenTarget,
  PreparedSession,
  PrepareOptions,
  RuntimeCapabilities,
  RuntimeHandle,
  RuntimeHandleEvent,
  RuntimeType,
} from '../../application/ports/runtime-session.js'
import { acpSelectionId } from '../../domain/identity/index.js'
import type { ProtocolModelCatalog } from '../../generated/protocol/v1_2/model-catalog.js'
import type { ProtocolPermissionItem } from '../../generated/protocol/v1_2/permission-catalog-response.js'
import { AgentPool, type PooledConnection } from '../supervisor/agent-pool.js'
import { AgentProcess, type AgentCommand } from '../supervisor/agent-process.js'
import { AcpClient, asRecord, type AgentInfo, type JsonRecord } from './client.js'
import { normalizeConfig, selectionsToConfig } from './config.js'
import type { AcpDialect, SelectionCodec } from './dialect.js'
import { RuntimeFailure } from './errors.js'
import type { JsonRpcPeer } from './jsonrpc.js'
import { translateUpdate } from './mapping.js'
import { prepareFailure, preparedSession } from './prepared.js'
import { EventQueue } from './queue.js'
import { AcpRuntimeSession, defaultIdentity } from './session.js'

/** 一条初始化过的 ACP 连接。 */
export interface AcpConnection extends PooledConnection {
  readonly client: AcpClient
  readonly info: AgentInfo
}

/** `scope.cwd`：按工作目录分进程时（MiMo）的进程工作目录。 */
export type ConnectionFactory = (scope?: { readonly cwd: string }) => Promise<AcpConnection>

/** 起一个适配器进程并完成 initialize。 */
export function processConnection(command: AgentCommand, dialect: AcpDialect, options: { initializeTimeoutMs?: number; onStderr?: (line: string) => void } = {}): ConnectionFactory {
  return async () => {
    const proc = new AgentProcess(command, options.onStderr ? { onStderr: options.onStderr } : {})
    const client = new AcpClient(proc.peer)
    try {
      const meta = dialect.initializeMeta?.()
      const info = await proc.withExit(client.initialize({
        protocolVersion: dialect.protocolVersion ?? 1,
        clientCapabilities: dialect.clientCapabilities(),
        ...(meta ? { meta } : {}),
        timeoutMs: options.initializeTimeoutMs ?? 120_000,
      }))
      return {
        client,
        info,
        get startedAt() { return proc.startedAt },
        get alive() { return proc.alive },
        get expectedExit() { return proc.expectedExit },
        get pid() { return proc.pid },
        exited: () => proc.exited(),
        stop: () => proc.stop(),
      }
    } catch (error) {
      await proc.stop()
      throw error
    }
  }
}

/** 已有的 JSON-RPC 对等端（测试、录制回放、DSH 插件 socket）上的连接。 */
export function peerConnection(peer: JsonRpcPeer, dialect: AcpDialect): ConnectionFactory {
  return async () => {
    const client = new AcpClient(peer)
    const meta = dialect.initializeMeta?.()
    const info = await client.initialize({ protocolVersion: dialect.protocolVersion ?? 1, clientCapabilities: dialect.clientCapabilities(), ...(meta ? { meta } : {}), timeoutMs: 30_000 })
    const startedAt = Date.now()
    let stopped = false
    return {
      client,
      info,
      startedAt,
      get alive() { return !peer.isClosed },
      get expectedExit() { return stopped },
      exited: () => peer.whenClosed(),
      stop: async () => {
        stopped = true
        peer.close('stopped')
      },
    }
  }
}

export interface AcpHandleOptions {
  readonly type: RuntimeType
  readonly instanceId: string
  readonly dialect: AcpDialect
  readonly connect: ConnectionFactory
  readonly idleMs?: number
  /** 不列出原生会话（v2 definition `native_inventory=False`）。 */
  readonly nativeInventory?: boolean
  /** 每个工作目录一个 Agent 进程，进程在该目录里启动（v2 `launch_in_workspace`）。 */
  readonly processPerWorkspace?: boolean
  /** 建会话前就能列出的权限选项（v2 definition `permission_options`：值, 名称）。 */
  readonly permissionOptions?: ReadonlyArray<readonly [string, string]>
  /** 完整的权限目录条目（带 v2 的 i18n、identity 等元数据），可按当前配置过滤；优先于 permissionOptions。 */
  readonly permissionCatalog?: (config: readonly ConfigOption[]) => readonly ProtocolPermissionItem[]
  /** Workspace preparation (`prepare`, capabilities `runtime.workspace.prepare` and `runtime.session.async_create`). */
  readonly workspacePreparation?: boolean
}

/** Runtime capabilities of a Runtime that prepares workspaces (runtime-workflows 1.2). */
export const WORKSPACE_PREPARATION_CAPABILITIES: readonly Capability[] = [
  { id: 'runtime.workspace.prepare', supported: true, parameters: { workflowVersion: '1.2' } },
  { id: 'runtime.session.async_create', supported: true, parameters: { workflowVersion: '1.2' } },
]

/** 会话能力：协商得到的 sessionCapabilities 里有没有某一项。 */
export function hasSessionCapability(info: AgentInfo, name: string): boolean {
  return asRecord(info.agentCapabilities.sessionCapabilities)[name] !== undefined
}

export class AcpRuntimeHandle implements RuntimeHandle {
  readonly type: RuntimeType
  readonly instanceId: string
  readonly events = new EventQueue<RuntimeHandleEvent>()
  /** 进程池：通常只有一个（键为空串）；按工作目录分进程时每个目录一个。 */
  private readonly pools = new Map<string, AgentPool<AcpConnection>>()
  private readonly sessions = new Map<AcpConnection, Set<AcpRuntimeSession>>()
  private info: AgentInfo | undefined
  private lastConfig: readonly ConfigOption[] = []

  constructor(private readonly options: AcpHandleOptions) {
    this.type = options.type
    this.instanceId = options.instanceId
  }

  private pool(scope: string): AgentPool<AcpConnection> {
    let pool = this.pools.get(scope)
    if (pool !== undefined) return pool
    const options = this.options
    pool = new AgentPool<AcpConnection>({
      start: async () => {
        const connection = await options.connect(scope === '' ? undefined : { cwd: scope })
        const known = this.info !== undefined
        this.info = connection.info
        // The capabilities come from `initialize`: the first connection makes them known (Server's runtime capabilities).
        if (!known) this.events.push({ type: 'capabilities.changed', capabilities: this.capabilities() })
        this.sessions.set(connection, new Set())
        for (const method of options.dialect.notificationMethods ?? []) {
          connection.client.onNotification(method, params => {
            for (const session of this.sessions.get(connection) ?? []) {
              if (session.nativeSessionId === params.sessionId) session.dialectNotification(method, params)
            }
          })
        }
        this.events.push({ type: 'status', status: 'ready' })
        return connection
      },
      busy: connection => [...(this.sessions.get(connection) ?? [])].some(session => session.busy),
      attached: connection => (this.sessions.get(connection)?.size ?? 0) > 0,
      lastActivity: connection => connection.client.lastActivity,
      ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
      onExit: (connection, reason, expected) => {
        for (const session of this.sessions.get(connection) ?? []) session.lost(reason)
        this.sessions.delete(connection)
        this.events.push(expected ? { type: 'status', status: 'stopped' } : { type: 'status', status: 'degraded', error: { code: 'runtime_crashed', message: reason, retryable: true } })
      },
    })
    this.pools.set(scope, pool)
    return pool
  }

  private scope(cwd: string | undefined): string {
    if (this.options.processPerWorkspace !== true || cwd === undefined) return ''
    try {
      return realpathSync(cwd)
    } catch {
      return resolve(cwd)
    }
  }

  /** 拿到连接（必要时启动进程）。 */
  connection(cwd?: string): Promise<AcpConnection> {
    return this.pool(this.scope(cwd)).acquire()
  }

  capabilities(): RuntimeCapabilities {
    const items: Capability[] = this.info ? this.options.dialect.capabilities(this.info) : []
    // Known before any Agent process ran: the new-session page decides on it before a session exists.
    if (this.options.workspacePreparation === true) items.push(...WORKSPACE_PREPARATION_CAPABILITIES)
    return { revision: 1, items }
  }

  async catalogs(sessionId?: string): Promise<Catalogs> {
    // The session's live configuration (it changes on every select), else the most recently opened one's.
    const config = this.openSession(sessionId)?.configOptions ?? this.lastConfig
    const fromConfig = catalogsFromConfig(this.type, config, this.options.dialect.selections)
    // acp/runtime.py `list_permission_catalog`
    const items = this.options.permissionCatalog?.(config)
      ?? this.options.permissionOptions?.map(([value, title]) => ({ id: value, displayName: title, description: null, default: false, selectionId: value, metadata: {} }))
    if (!items?.length) return fromConfig
    return { ...fromConfig, permissions: { runtime: this.type, revision: 1, permissions: [...items] } }
  }

  private openSession(sessionId: string | undefined): AcpRuntimeSession | undefined {
    if (sessionId === undefined) return undefined
    for (const set of this.sessions.values()) for (const session of set) if (session.sessionId === sessionId) return session
    return undefined
  }

  async listNativeSessions(cursor?: string): Promise<NativeSessionPage> {
    if (this.options.nativeInventory === false) return { sessions: [] }
    const connection = await this.connection()
    if (!hasSessionCapability(connection.info, 'list')) return { sessions: [] }
    const result = asRecord(await connection.client.request('session/list', cursor !== undefined ? { cursor } : {}, { timeoutMs: 60_000 }))
    const sessions: NativeSessionSummary[] = (Array.isArray(result.sessions) ? result.sessions.map(asRecord) : [])
      .filter(s => typeof s.sessionId === 'string')
      .map(s => ({
        nativeSessionId: String(s.sessionId),
        ...(typeof s.title === 'string' ? { title: s.title } : {}),
        ...(typeof s.cwd === 'string' ? { cwd: s.cwd } : {}),
        ...(typeof s.updatedAt === 'string' ? { updatedAt: s.updatedAt } : {}),
      }))
    return { sessions, ...(typeof result.nextCursor === 'string' ? { nextCursor: result.nextCursor } : {}) }
  }

  async readNativeHistory(ref: NativeSessionRef, window: HistoryWindow): Promise<NativeHistoryPage> {
    // 方言自己的只读实现（Claude 读 JSONL）不一定需要 Agent 进程，按需再取连接。
    const special = this.options.dialect.readNativeHistory?.(ref, window, () => this.connection(ref.locator))
    if (special !== undefined) return special
    const connection = await this.connection(ref.locator)
    // 通用实现：加载并捕获回放，再关闭。会写原生记录的 Runtime（Claude）必须由方言或原生历史伴随层接管。
    if (connection.info.agentCapabilities.loadSession !== true) return { items: [] }
    const { updates } = await connection.client.capture(ref.nativeSessionId, () => connection.client.request('session/load', {
      sessionId: ref.nativeSessionId, cwd: ref.locator ?? process.cwd(), mcpServers: [], ...(this.options.dialect.openParams?.(ref) ?? {}),
    }, { timeoutMs: 120_000 }))
    if (hasSessionCapability(connection.info, 'close')) await connection.client.request('session/close', { sessionId: ref.nativeSessionId }, { timeoutMs: 15_000 }).catch(() => undefined)
    const identity = defaultIdentity({ sessionId: `history:${ref.nativeSessionId}`, nativeSessionId: ref.nativeSessionId, epoch: 'history', info: connection.info })
    const items: HistoryItem[] = []
    for (const update of updates) {
      for (const event of translateUpdate(update, { identity, replay: true, suppressUserEcho: false, config: [] })) {
        if (event.type === 'message.delta' || event.type === 'message.completed' || event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'notice') items.push(event)
      }
    }
    const limited = window.limit > 0 && items.length > window.limit ? items.slice(-window.limit) : items
    return { items: limited }
  }

  async open(target: OpenTarget, options: OpenOptions): Promise<AcpRuntimeSession> {
    if (this.draining) throw new RuntimeFailure({ code: 'runtime_route_switching', message: 'this route is being handed over', retryable: true })
    const connection = await this.connection(target.kind === 'new' ? target.spec.cwd : target.ref.locator)
    const { client, info } = connection
    const dialect = this.options.dialect
    let nativeSessionId: string
    let response: JsonRecord
    let replayed: JsonRecord[] = []
    if (target.kind === 'new') {
      response = asRecord(await client.request('session/new', {
        cwd: target.spec.cwd,
        mcpServers: [],
        ...(target.spec.additionalDirectories?.length ? { additionalDirectories: target.spec.additionalDirectories } : {}),
        ...(dialect.newSessionParams?.(target.spec) ?? {}),
      }, { timeoutMs: 120_000 }))
      nativeSessionId = String(response.sessionId)
    } else {
      nativeSessionId = target.ref.nativeSessionId
      const params = { sessionId: nativeSessionId, cwd: target.ref.locator ?? process.cwd(), mcpServers: [], ...(dialect.openParams?.(target.ref) ?? {}) }
      const canResume = hasSessionCapability(info, 'resume')
      if (options.replay === 'none' && canResume) {
        response = asRecord(await client.request('session/resume', params, { timeoutMs: 120_000 }))
      } else {
        const captured = await client.capture(nativeSessionId, () => client.request('session/load', params, { timeoutMs: 120_000 }))
        response = asRecord(captured.result)
        replayed = options.replay === 'full' ? captured.updates : []
      }
    }
    const config = normalizeConfig({ configOptions: response.configOptions, modes: response.modes, models: response.models }, dialect.legacyModes)
    const session = new AcpRuntimeSession({
      client, dialect, sessionId: options.sessionId, nativeSessionId, info, config, canClose: hasSessionCapability(info, 'close'),
    })
    this.lastConfig = session.configOptions
    this.sessions.get(connection)?.add(session)
    const originalClose = session.close.bind(session)
    session.close = async () => {
      this.sessions.get(connection)?.delete(session)
      await originalClose()
    }
    const problem = dialect.verifySession?.(session.configOptions, response, nativeSessionId)
    if (problem !== undefined) {
      await session.close().catch(() => undefined)
      throw new RuntimeFailure(problem)
    }
    if (replayed.length) session.replay(replayed)
    if (target.kind === 'new' && target.spec.selections) await this.applySelections(session, target.spec.selections)
    return session
  }

  /**
   * Creates the native session in `spec.cwd` ahead of its AA session (its id is the preparation's until `adopt`).
   * Errors carry `details.definite` when the Agent never got the session request (the process did not start).
   */
  async prepare(spec: NewSessionSpec, options: PrepareOptions): Promise<PreparedSession> {
    if (this.options.workspacePreparation !== true) throw new RuntimeFailure({ code: 'workflow_unsupported', message: 'this Runtime does not prepare workspaces' })
    try {
      await this.connection(spec.cwd)
    } catch (error) {
      throw prepareFailure(error, true)
    }
    let session: AcpRuntimeSession
    try {
      session = await this.open({ kind: 'new', spec: { cwd: spec.cwd } }, { sessionId: options.preparationId, replay: 'none' })
    } catch (error) {
      throw prepareFailure(error, false)
    }
    return preparedSession(session, {
      catalogs: () => this.catalogs(session.sessionId),
      ...(this.options.dialect.selections !== undefined ? { codec: this.options.dialect.selections } : {}),
    })
  }

  /**
   * 创建时的初始选择（类别 → selection ID）落到会话配置（v2 `merge_legacy` + `configurations.update`）。
   * 映射不唯一、值不可用或设置失败都让创建失败，并关闭刚建的会话。
   */
  private async applySelections(session: AcpRuntimeSession, selections: Readonly<Record<string, string | null>>): Promise<void> {
    try {
      for (const change of selectionsToConfig(session.configOptions, selections, this.options.dialect.selections)) await session.configure(change)
    } catch (error) {
      await session.close().catch(() => undefined)
      throw error
    }
  }
  async stop(): Promise<void> {
    await Promise.all([...this.pools.values()].map(pool => pool.shutdown()))
    this.events.close()
  }

  private draining = false

  /** 打开的会话（路由切换时按会话交接）。 */
  openSessions(): AcpRuntimeSession[] {
    return [...this.sessions.values()].flatMap(set => [...set])
  }

  /**
   * 把这条路由让出去（04 §5.6「路由切换要交接写锁」）：不再打开新会话；空闲会话立即关闭，运行中的等回合
   * 结束再关；全部关完后停掉进程。返回时这条路由持有的写锁都已释放。`onReleased` 在每个会话关闭后调用，
   * 上层据此把它切到新路由。
   */
  async drain(onReleased?: (session: AcpRuntimeSession) => void): Promise<void> {
    this.draining = true
    await Promise.all(this.openSessions().map(async session => {
      await session.releaseBetweenTurns()
      onReleased?.(session)
    }))
    const pools = [...this.pools.values()]
    // 关掉的进程池不能再用：之后若重新允许打开（resumeOpening），按需建新进程池。
    this.pools.clear()
    await Promise.all(pools.map(pool => pool.shutdown()))
  }

  /** 交接取消（例如新路由没起来）：重新允许打开会话。 */
  resumeOpening(): void {
    this.draining = false
  }
}

/** 从会话配置项生成 AA 模型目录（selection ID 沿用 v2 ACP 规则）。 */
export function catalogsFromConfig(runtime: string, options: readonly ConfigOption[], codec?: SelectionCodec): Catalogs {
  const model = options.find(o => o.category === 'model' && o.type === 'select')
  if (!model?.values?.length) return {}
  const effort = options.find(o => o.category === 'effort' && o.type === 'select')
  const hidden = new Set(codec?.hiddenEfforts ?? [])
  const efforts = (effort?.values ?? []).filter(e => !hidden.has(e.value))
  // acp/domain/catalogs.py: a model alone is its raw value; only a model with a reasoning effort is encoded
  // (`decodeAcpSelection` rejects an encoded null effort).
  const selectionId = codec
    ? (m: string, e: string | null) => codec.modelSelectionId(m, e)
    : (m: string, e: string | null) => (e === null ? m : acpSelectionId(m, e))
  const models: ProtocolModelCatalog = {
    runtime,
    revision: 1,
    models: model.values.map(value => ({
      id: value.value,
      displayName: value.name,
      ...(value.description ? { description: value.description } : {}),
      default: value.value === model.currentValue,
      selectionId: selectionId(value.value, null),
      reasoningItems: efforts.map(e => ({ id: e.value, displayName: e.name, default: e.value === effort?.currentValue, selectionId: selectionId(value.value, e.value) })),
    })),
  }
  const currentEffort = effort && !hidden.has(String(effort.currentValue)) ? String(effort.currentValue) : null
  // acp/application/sessions.py `state`: the current value of each model / permission / effort option.
  const selections: Record<string, string> = { model: selectionId(String(model.currentValue), currentEffort) }
  for (const category of ['permission', 'effort'] as const) {
    const option = options.find(o => o.category === category && o.type === 'select')
    if (typeof option?.currentValue === 'string') selections[category] = option.currentValue
  }
  return { models, selections }
}
