// RuntimeHandle / RuntimeProvider 的通用 ACP 实现：进程池 + ACP 客户端 + 方言。
// 进程监督在 supervisor/，会话引擎在 session.ts；这里负责打开会话、原生会话目录、只读历史与运行时级事件。

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
  OpenOptions,
  OpenTarget,
  RuntimeCapabilities,
  RuntimeHandle,
  RuntimeHandleEvent,
  RuntimeType,
} from '../../application/ports/runtime-session.js'
import { acpSelectionId } from '../../domain/identity/index.js'
import type { ProtocolModelCatalog } from '../../generated/protocol/v1_2/model-catalog.js'
import { AgentPool, type PooledConnection } from '../supervisor/agent-pool.js'
import { AgentProcess, type AgentCommand } from '../supervisor/agent-process.js'
import { AcpClient, asRecord, type AgentInfo, type JsonRecord } from './client.js'
import { normalizeConfig, selectionsToConfig } from './config.js'
import type { AcpDialect } from './dialect.js'
import { RuntimeFailure } from './errors.js'
import type { JsonRpcPeer } from './jsonrpc.js'
import { translateUpdate } from './mapping.js'
import { EventQueue } from './queue.js'
import { AcpRuntimeSession, defaultIdentity } from './session.js'

/** 一条初始化过的 ACP 连接。 */
export interface AcpConnection extends PooledConnection {
  readonly client: AcpClient
  readonly info: AgentInfo
}

export type ConnectionFactory = () => Promise<AcpConnection>

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
  /** 建会话前就能列出的权限选项（v2 definition `permission_options`：值, 名称）。 */
  readonly permissionOptions?: ReadonlyArray<readonly [string, string]>
}

/** 会话能力：协商得到的 sessionCapabilities 里有没有某一项。 */
export function hasSessionCapability(info: AgentInfo, name: string): boolean {
  return asRecord(info.agentCapabilities.sessionCapabilities)[name] !== undefined
}

export class AcpRuntimeHandle implements RuntimeHandle {
  readonly type: RuntimeType
  readonly instanceId: string
  readonly events = new EventQueue<RuntimeHandleEvent>()
  private readonly pool: AgentPool<AcpConnection>
  private readonly sessions = new Map<AcpConnection, Set<AcpRuntimeSession>>()
  private info: AgentInfo | undefined
  private lastConfig: readonly ConfigOption[] = []

  constructor(private readonly options: AcpHandleOptions) {
    this.type = options.type
    this.instanceId = options.instanceId
    this.pool = new AgentPool<AcpConnection>({
      start: async () => {
        const connection = await options.connect()
        this.info = connection.info
        this.sessions.set(connection, new Set())
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
  }

  /** 拿到连接（必要时启动进程）。 */
  connection(): Promise<AcpConnection> {
    return this.pool.acquire()
  }

  capabilities(): RuntimeCapabilities {
    const items: Capability[] = this.info ? this.options.dialect.capabilities(this.info) : []
    return { revision: 1, items }
  }

  async catalogs(): Promise<Catalogs> {
    const fromConfig = catalogsFromConfig(this.type, this.lastConfig)
    const permissions = this.options.permissionOptions
    if (!permissions?.length) return fromConfig
    // acp/runtime.py `list_permission_catalog`
    return {
      ...fromConfig,
      permissions: {
        runtime: this.type,
        revision: 1,
        permissions: permissions.map(([value, title]) => ({ id: value, displayName: title, description: null, default: false, selectionId: value, metadata: {} })),
      },
    }
  }

  async listNativeSessions(cursor?: string): Promise<NativeSessionPage> {
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
    const connection = await this.connection()
    const special = this.options.dialect.readNativeHistory?.(connection.client, ref, `history:${ref.nativeSessionId}`)
    if (special !== undefined) return special
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
    const connection = await this.connection()
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
    const config = normalizeConfig({ configOptions: response.configOptions, modes: response.modes, models: response.models })
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
    const problem = dialect.verifySession?.(session.configOptions)
    if (problem !== undefined) {
      await session.close().catch(() => undefined)
      throw new RuntimeFailure(problem)
    }
    if (replayed.length) session.replay(replayed)
    if (target.kind === 'new' && target.spec.selections) await this.applySelections(session, target.spec.selections)
    return session
  }

  /**
   * 创建时的初始选择（类别 → selection ID）落到会话配置（v2 `merge_legacy` + `configurations.update`）。
   * 映射不唯一、值不可用或设置失败都让创建失败，并关闭刚建的会话。
   */
  private async applySelections(session: AcpRuntimeSession, selections: Readonly<Record<string, string | null>>): Promise<void> {
    try {
      for (const change of selectionsToConfig(session.configOptions, selections)) await session.configure(change)
    } catch (error) {
      await session.close().catch(() => undefined)
      throw error
    }
  }
 async stop(): Promise<void> {
    await this.pool.shutdown()
    this.events.close()
  }
}

/** 从会话配置项生成 AA 模型目录（selection ID 沿用 v2 ACP 规则）。 */
export function catalogsFromConfig(runtime: string, options: readonly ConfigOption[]): Catalogs {
  const model = options.find(o => o.category === 'model' && o.type === 'select')
  if (!model?.values?.length) return {}
  const effort = options.find(o => o.category === 'effort' && o.type === 'select')
  const efforts = effort?.values ?? []
  const models: ProtocolModelCatalog = {
    runtime,
    revision: 1,
    models: model.values.map(value => ({
      id: value.value,
      displayName: value.name,
      ...(value.description ? { description: value.description } : {}),
      default: value.value === model.currentValue,
      selectionId: acpSelectionId(value.value, null),
      reasoningItems: efforts.map(e => ({ id: e.value, displayName: e.name, default: e.value === effort?.currentValue, selectionId: acpSelectionId(value.value, e.value) })),
    })),
  }
  return { models, selections: { model: acpSelectionId(String(model.currentValue), effort ? String(effort.currentValue) : null) } }
}
