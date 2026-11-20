// Generic ACP implementation of RuntimeHandle / RuntimeProvider: process pool + ACP client + dialect.
// Process supervision lives in supervisor/ and the session engine in session.ts; this file opens sessions and
// handles the native session inventory, read-only history and runtime-level events.

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import type {
  AgentProcessInfo,
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
  ToolServerSpec,
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

/** An initialized ACP connection. */
export interface AcpConnection extends PooledConnection {
  readonly client: AcpClient
  readonly info: AgentInfo
}

/** `scope.cwd`: the process working directory when processes are split per workspace (MiMo). */
export type ConnectionFactory = (scope?: { readonly cwd: string }) => Promise<AcpConnection>

/** Starts an adapter process and completes initialize. */
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

/** A connection over an existing JSON-RPC peer (tests, recording replay, the DSH plugin socket). */
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
  /** Do not list native sessions. */
  readonly nativeInventory?: boolean
  /** One Agent process per workspace, started in that workspace. */
  readonly processPerWorkspace?: boolean
  /** Permission options that can be listed before a session is created (value, name). */
  readonly permissionOptions?: ReadonlyArray<readonly [string, string]>
  /** Full permission catalog entries (with i18n, identity and other metadata), filterable by the current config; takes precedence over permissionOptions. */
  readonly permissionCatalog?: (config: readonly ConfigOption[]) => readonly ProtocolPermissionItem[]
  /** Workspace preparation (`prepare`, capabilities `runtime.workspace.prepare` and `runtime.session.async_create`). */
  readonly workspacePreparation?: boolean
}

/** Runtime capabilities of a Runtime that prepares workspaces (runtime-workflows 1.2). */
export const WORKSPACE_PREPARATION_CAPABILITIES: readonly Capability[] = [
  { id: 'runtime.workspace.prepare', supported: true, parameters: { workflowVersion: '1.2' } },
  { id: 'runtime.session.async_create', supported: true, parameters: { workflowVersion: '1.2' } },
]

/** Session capability: whether the negotiated sessionCapabilities include an entry. */
export function hasSessionCapability(info: AgentInfo, name: string): boolean {
  return asRecord(info.agentCapabilities.sessionCapabilities)[name] !== undefined
}

export class AcpRuntimeHandle implements RuntimeHandle {
  readonly type: RuntimeType
  readonly instanceId: string
  readonly events = new EventQueue<RuntimeHandleEvent>()
  /** Process pools: usually just one (empty-string key); one per workspace when processes are split per workspace. */
  private readonly pools = new Map<string, AgentPool<AcpConnection>>()
  private readonly sessions = new Map<AcpConnection, Set<AcpRuntimeSession>>()
  private info: AgentInfo | undefined
  private lastConfig: readonly ConfigOption[] = []
  /** The model catalog last announced in `catalogs.changed`. */
  private announcedModels: string | null = null

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

  /** Gets a connection (starting the process when needed). */
  connection(cwd?: string): Promise<AcpConnection> {
    return this.pool(this.scope(cwd)).acquire()
  }

  capabilities(): RuntimeCapabilities {
    const items: Capability[] = this.info ? this.options.dialect.capabilities(this.info) : []
    // Known before any Agent process ran: the new-session page decides on it before a session exists.
    if (this.options.workspacePreparation === true) items.push(...WORKSPACE_PREPARATION_CAPABILITIES)
    if (this.options.dialect.agentTools === true) items.push(AGENT_TOOLS_HOST)
    return { revision: 1, items }
  }

  async catalogs(sessionId?: string): Promise<Catalogs> {
    // The session's live configuration (it changes on every select), else the most recently opened one's.
    const config = this.openSession(sessionId)?.configOptions ?? this.lastConfig
    const fromConfig = catalogsFromConfig(this.type, config, this.options.dialect.selections)
    // Permission catalog: the full catalog when provided, else the static permission options.
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
    // The dialect's own read-only implementation (Claude reads JSONL) may not need an Agent process; get a connection only when needed.
    const special = this.options.dialect.readNativeHistory?.(ref, window, () => this.connection(ref.locator ?? ref.cwd))
    if (special !== undefined) return special
    const connection = await this.connection(ref.locator ?? ref.cwd)
    // Generic implementation: load and capture the replay, then close. Runtimes that write native records (Claude) must be handled by the dialect or the native history companion.
    if (connection.info.agentCapabilities.loadSession !== true) return { items: [] }
    const { updates } = await connection.client.capture(ref.nativeSessionId, () => connection.client.request('session/load', {
      sessionId: ref.nativeSessionId, cwd: ref.locator ?? ref.cwd ?? process.cwd(), mcpServers: [], ...(this.options.dialect.openParams?.(ref) ?? {}),
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
    const connection = await this.connection(target.kind === 'new' ? target.spec.cwd : target.ref.locator ?? target.ref.cwd)
    const { client, info } = connection
    const dialect = this.options.dialect
    const tools = dialect.agentTools === true ? options.toolServers ?? [] : []
    const mcpServers = tools.map(stdioMcpServer)
    let nativeSessionId: string
    let response: JsonRecord
    let replayed: JsonRecord[] = []
    if (target.kind === 'new') {
      response = asRecord(await client.request('session/new', {
        cwd: target.spec.cwd,
        mcpServers,
        ...(target.spec.additionalDirectories?.length ? { additionalDirectories: [...target.spec.additionalDirectories] } : {}),
        ...(dialect.newSessionParams?.(target.spec) ?? {}),
      }, { timeoutMs: 120_000 }))
      nativeSessionId = String(response.sessionId)
    } else {
      nativeSessionId = target.ref.nativeSessionId
      const params = { sessionId: nativeSessionId, cwd: target.ref.locator ?? target.ref.cwd ?? process.cwd(), mcpServers, ...(dialect.openParams?.(target.ref) ?? {}) }
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
    this.announceCatalogs()
    return session
  }

  /**
   * Instance-level catalogs exist only once a session has been opened: tell the Connector when the models they list
   * change, so it can keep them for the new-session page after a restart.
   */
  private announceCatalogs(): void {
    void this.catalogs().then(catalogs => {
      if (catalogs.models === undefined) return
      const models = JSON.stringify(catalogs.models)
      if (models === this.announcedModels) return
      this.announcedModels = models
      this.events.push({ type: 'catalogs.changed', catalogs })
    }, () => undefined)
  }

  /**
   * Creates the native session in `spec.cwd` ahead of its AA session (its id is the preparation's until `adopt`).
   * Errors carry `details.definite` when the Agent never got the session request (the process did not start).
   */
  async prepare(spec: NewSessionSpec, options: PrepareOptions, onOpen?: (session: AcpRuntimeSession) => void): Promise<PreparedSession> {
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
    onOpen?.(session)
    return preparedSession(session, {
      catalogs: () => this.catalogs(session.sessionId),
      ...(this.options.dialect.selections !== undefined ? { codec: this.options.dialect.selections } : {}),
    })
  }

  /**
   * Applies the initial selections given at creation (category -> selection ID) to the session config.
   * A non-unique mapping, an unavailable value or a failed set fails the creation and closes the new session.
   */
  private async applySelections(session: AcpRuntimeSession, selections: Readonly<Record<string, string | null>>): Promise<void> {
    try {
      for (const change of selectionsToConfig(session.configOptions, selections, this.options.dialect.selections)) await session.configure(change)
    } catch (error) {
      await session.close().catch(() => undefined)
      throw error
    }
  }
  /** The live adapter process of each pool and the sessions open on it, busy ones first. */
  agentProcesses(): AgentProcessInfo[] {
    const processes: AgentProcessInfo[] = []
    for (const pool of this.pools.values()) {
      const connection = pool.live()
      if (connection?.pid === undefined) continue
      const sessions = [...(this.sessions.get(connection) ?? [])]
      processes.push({ pid: connection.pid, sessionIds: [...sessions.filter(s => s.busy), ...sessions.filter(s => !s.busy)].map(s => s.sessionId) })
    }
    return processes
  }

  async stop(): Promise<void> {
    await Promise.all([...this.pools.values()].map(pool => pool.shutdown()))
    this.events.close()
  }

  private draining = false

  /** Open sessions (handed over per session when the route switches). */
  openSessions(): AcpRuntimeSession[] {
    return [...this.sessions.values()].flatMap(set => [...set])
  }

  /**
   * Gives up this route (04 §5.6 "route switches hand over the write lock"): no new sessions are opened; idle
   * sessions close at once and running ones close after their turn ends; once all are closed the processes stop.
   * When this returns, every write lock held by this route has been released. `onReleased` is called after each
   * session closes, so the caller can move it to the new route.
   */
  async drain(onReleased?: (session: AcpRuntimeSession) => void): Promise<void> {
    this.draining = true
    await Promise.all(this.openSessions().map(async session => {
      await session.releaseBetweenTurns()
      onReleased?.(session)
    }))
    const pools = [...this.pools.values()]
    // A closed process pool cannot be reused: if opening is allowed again later (resumeOpening), a new pool is created on demand.
    this.pools.clear()
    await Promise.all(pools.map(pool => pool.shutdown()))
  }

  /** Handover cancelled (e.g. the new route did not come up): allows opening sessions again. */
  resumeOpening(): void {
    this.draining = false
  }
}

/** Builds the AA model catalog from the session config options (selection IDs follow the generic ACP rules). */
export function catalogsFromConfig(runtime: string, options: readonly ConfigOption[], codec?: SelectionCodec): Catalogs {
  const model = options.find(o => o.category === 'model' && o.type === 'select')
  if (!model?.values?.length) return {}
  const effort = options.find(o => o.category === 'effort' && o.type === 'select')
  const hidden = new Set(codec?.hiddenEfforts ?? [])
  const efforts = (effort?.values ?? []).filter(e => !hidden.has(e.value))
  // A model alone is its raw value; only a model with a reasoning effort is encoded
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
  // The current value of each model / permission / effort option.
  const selections: Record<string, string> = { model: selectionId(String(model.currentValue), currentEffort) }
  for (const category of ['permission', 'effort'] as const) {
    const option = options.find(o => o.category === category && o.type === 'select')
    if (typeof option?.currentValue === 'string') selections[category] = option.currentValue
  }
  return { models, selections }
}

/** A tool server as an ACP stdio `McpServer`. */
export function stdioMcpServer(server: ToolServerSpec): JsonRecord {
  return {
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  }
}

/** The Runtime can host the collaboration tools (docs/agent-collaboration.md, AC11). */
export const AGENT_TOOLS_HOST: Capability = Object.freeze({ id: 'runtime.agent_tools.host', supported: true })
