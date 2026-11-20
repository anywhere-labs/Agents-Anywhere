/**
 * One DSH runtime instance across its routes (04-connector.md §5.6, DSH-5): DSH's automation ACP
 * started by the Connector (direct) and every DSH host whose plugin dialled in (plugin). The
 * session engine sees one `RuntimeHandle` and sessions that stay open while their route changes.
 *
 * Routing:
 * - A plugin host, when one serves this DSH home, else the direct route. With several hosts
 *   (DSH Desktop and `dsh web`), the newest is asked first and a host that reports the session's
 *   write lock held (`writer_held`) passes it to the next.
 * - A host appearing takes the direct sessions over: idle ones move now, running ones after
 *   their turn (B's `drain`); prompts arriving meanwhile wait for the move instead of failing.
 * - A host going away: its in-flight turn ends with an unknown result (B's engine: a failure
 *   card, never resent) and its sessions move to the next host or back to the direct route.
 * - A host the Connector cannot use (DSH version out of range, another DSH home) is refused and
 *   reported; the direct route keeps serving.
 * - DSH Desktop with the session open but no plugin: the direct route gets DSH's write lock, and
 *   AA can only say so (`writer_held`, hint `install_dsh_plugin`).
 */
import { resolve } from 'node:path'
import type { Capability, Catalogs, CommandResult, ConfigChange, ConfigResult, DeliveryRef, HistoryWindow, InteractionAnswer, InteractionRefusal,
  NativeHistoryPage, NativeSessionPage, NativeSessionRef, NewSessionSpec, OpenOptions, OpenTarget, PrepareOptions, PreparedSession, PromptAcceptance, PromptInput, RuntimeCapabilities,
  RuntimeError, RuntimeEvent, RuntimeHandle, RuntimeHandleEvent, RuntimeSession, SteerResult } from '../../../application/ports/runtime-session.js'
import { asRecord } from '../../acp/client.js'
import { RuntimeFailure } from '../../acp/errors.js'
import { AGENT_TOOLS_HOST, AcpRuntimeHandle, WORKSPACE_PREPARATION_CAPABILITIES, type ConnectionFactory } from '../../acp/handle.js'
import { JsonRpcError } from '../../acp/jsonrpc.js'
import { EventQueue } from '../../acp/queue.js'
import { createDirectSession } from './direct/create.js'
import { directPromptProblem, dshDirectDialect, isWriterHeld, writerHeld } from './direct/dialect.js'
import { supportedDshVersion } from './launcher.js'
import { DIRECT_ROUTE_REASON } from './capabilities.js'
import { isTurnFailureCard, pluginPromptProblem } from './plugin/dialect.js'
import type { DshHostHello, DshPluginRoute } from './plugin/route.js'
import type { DshSessionIds } from './session-ids.js'

export type DshRouteKind = 'direct' | 'plugin'
type Route = { readonly kind: 'direct' } | { readonly kind: 'plugin', readonly host: DshPluginRoute }

export interface DshRuntimeOptions {
  readonly instanceId: string
  /** Starts DSH's automation ACP; absent when no `dsh` is available (plugin hosts only). */
  readonly direct?: ConnectionFactory
  readonly directInventoryReady?: () => Promise<boolean>
  /** Aliases for sessions the direct route creates (DSH picks their IDs, DSH-2). */
  readonly ids?: DshSessionIds
  /** The DSH home this instance serves; hosts reporting another one are not used. */
  readonly dshHome?: string
  /** Moves of one session allowed per minute before a lost route is reported (crash loops). */
  readonly moveLimit?: number
}

/**
 * Why a host cannot serve this instance, or undefined. The bridge protocol itself (3.0) is checked
 * by the socket listener before a host gets here; the plugin's package version follows the AA
 * release and says nothing more.
 */
export function hostProblem(hello: DshHostHello, dshHome?: string): RuntimeError | undefined {
  if (!supportedDshVersion(hello.dshVersion)) {
    return { code: 'agent_version_unsupported', message: `DSH ${hello.dshVersion} 不在这个 Connector 支持的范围内，请升级 DSH 或 Connector。`,
      details: { hostInstance: hello.hostInstance, dshVersion: hello.dshVersion } }
  }
  if (dshHome && hello.dshHome && resolve(hello.dshHome) !== resolve(dshHome)) {
    return { code: 'dsh_home_mismatch', message: '这个 DSH 使用的是另一个数据目录，不服务这个 Runtime。',
      details: { hostInstance: hello.hostInstance, dshHome: hello.dshHome } }
  }
  return undefined
}

function pluginWriterHeld(error: unknown): boolean {
  return error instanceof JsonRpcError && asRecord(error.data).code === 'writer_held'
}

function runtimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeFailure) return error.error
  return { code: 'runtime_disconnected', message: error instanceof Error ? error.message : String(error), retryable: true }
}

export class DshRuntime implements RuntimeHandle {
  readonly type = 'dsh' as const
  readonly instanceId: string
  readonly events = new EventQueue<RuntimeHandleEvent>()
  private directHandle: AcpRuntimeHandle | undefined
  private readonly hosts: DshPluginRoute[] = []
  private readonly sessions = new Set<DshSession>()
  private handover: Promise<void> = Promise.resolve()
  private revision = 1
  private stopped = false

  constructor(private readonly options: DshRuntimeOptions) {
    this.instanceId = options.instanceId
  }

  /** The route new sessions go to now. */
  get activeRoute(): DshRouteKind { return this.hosts.length ? 'plugin' : 'direct' }
  get connectedHosts(): readonly DshHostHello[] { return this.hosts.map(host => host.hello) }
  get openSessions(): readonly DshSession[] { return [...this.sessions] }

  // ------------------------------------------------------------------ hosts

  /** A verified host connection (A's `DshBridgeListener` → `dshPluginRoute`). Returns why it was refused. */
  attachHost(route: DshPluginRoute): RuntimeError | undefined {
    const problem = this.stopped ? { code: 'runtime_stopping', message: 'This DSH runtime is stopping.' } : hostProblem(route.hello, this.options.dshHome)
    if (problem) {
      void route.handle.stop().catch(() => undefined)
      this.events.push({ type: 'status', status: 'degraded', error: problem })
      return problem
    }
    // The same host reconnecting (a plugin reload) replaces its old connection.
    const previous = this.hosts.findIndex(host => host.hello.hostInstance === route.hello.hostInstance)
    if (previous >= 0) this.hosts.splice(previous, 1)
    this.hosts.push(route)
    void route.closed.then(() => this.detachHost(route))
    this.capabilitiesChanged()
    this.handover = this.handOverDirect()
    return undefined
  }

  private detachHost(route: DshPluginRoute): void {
    const index = this.hosts.indexOf(route)
    if (index < 0) return
    this.hosts.splice(index, 1)
    // Its sessions see `session.lost` from B's engine and move on (DshSession.lost).
    void route.handle.stop().catch(() => undefined)
    this.capabilitiesChanged()
  }

  /** Direct sessions move to the plugin host: idle now, running after their turn. */
  private async handOverDirect(): Promise<void> {
    const direct = this.directHandle
    if (!direct) return
    const moving = [...this.sessions].filter(session => session.route.kind === 'direct')
    for (const session of moving) session.holdCalls()
    this.directHandle = undefined
    await direct.drain(released => {
      const session = moving.find(item => item.inner === released)
      if (session) void session.move()
    })
    // Sessions the drain did not release (already closed) must not keep waiting.
    for (const session of moving) if (session.route.kind === 'direct') void session.move()
  }

  private capabilitiesChanged(): void {
    this.revision++
    this.events.push({ type: 'capabilities.changed', capabilities: this.capabilities() })
  }

  // ------------------------------------------------------------------ RuntimeHandle

  private direct(): AcpRuntimeHandle {
    if (!this.options.direct) {
      throw new RuntimeFailure({ code: 'runtime_unavailable', retryable: true,
        message: '没有可用的 DSH：在这台设备上安装 DSH，或打开装有 Agents Anywhere 插件的 DSH Desktop。' })
    }
    if (this.directHandle === undefined) {
      const handle = new AcpRuntimeHandle({ type: 'dsh', instanceId: this.instanceId, dialect: dshDirectDialect(),
        connect: this.options.direct, nativeInventory: true, workspacePreparation: true })
      this.directHandle = handle
      void this.publishDirectEvents(handle)
    }
    return this.directHandle
  }

  private async publishDirectEvents(handle: AcpRuntimeHandle): Promise<void> {
    for await (const event of handle.events) {
      if (this.directHandle !== handle || this.activeRoute !== 'direct') continue
      if (event.type === 'capabilities.changed') this.capabilitiesChanged()
      if (event.type === 'catalogs.changed') this.events.push(event)
    }
  }

  private activeHandle(): AcpRuntimeHandle | undefined {
    return (this.hosts.at(-1)?.handle as AcpRuntimeHandle | undefined) ?? this.directHandle
  }

  capabilities(): RuntimeCapabilities {
    const host = this.hosts.at(-1)
    const items: Capability[] = [...(this.activeHandle()?.capabilities().items ?? [])]
    if (!host && this.options.direct) {
      if (!this.directHandle) items.push(...WORKSPACE_PREPARATION_CAPABILITIES)
      // An existing conversation can start a stopped direct ACP process by sending a text prompt.
      if (!items.some(item => item.id === 'session.send_message')) items.push({ id: 'session.send_message', supported: true })
      // The direct route takes injected tool servers (measured); the plugin route is not measured and does not declare it.
      if (!items.some(item => item.id === AGENT_TOOLS_HOST.id)) items.push(AGENT_TOOLS_HOST)
    }
    items.push({ id: 'runtime.route', supported: true, parameters: host
      ? { route: 'plugin', hostInstance: host.hello.hostInstance, hostKind: host.hello.hostKind, dshVersion: host.hello.dshVersion }
      : { route: 'direct', available: this.options.direct !== undefined } })
    return { revision: this.revision, items }
  }

  async catalogs(sessionId?: string): Promise<Catalogs> { return (await this.activeHandle()?.catalogs(sessionId)) ?? {} }

  async prepare(spec: NewSessionSpec, options: PrepareOptions): Promise<PreparedSession> {
    await this.handover
    if (this.hosts.length) throw new RuntimeFailure({ code: 'workflow_unsupported', message: 'DSH plugin sessions do not prepare workspaces.' })
    // DSH exposes its model options only after session/new. Reuse that native session for the first turn.
    const prepared = await this.direct().prepare(spec, options)
    return {
      ...prepared,
      get configOptions() { return prepared.configOptions },
      async adopt(sessionId, frozen) {
        const session = await prepared.adopt(sessionId, frozen)
        const prompt = session.prompt.bind(session)
        session.prompt = (input, delivery) => {
          const problem = directPromptProblem(input)
          return problem === undefined ? prompt(input, delivery) : Promise.resolve({ outcome: 'rejected', error: problem })
        }
        return session
      },
    }
  }

  async listNativeSessions(cursor?: string): Promise<NativeSessionPage> {
    const host = this.hosts.at(-1)
    if (host) return host.handle.listNativeSessions(cursor)
    if (this.options.directInventoryReady && !await this.options.directInventoryReady()) return { sessions: [], complete: false }
    return this.options.direct ? this.direct().listNativeSessions(cursor) : { sessions: [] }
  }

  /** Only the plugin replays history with stable item IDs; DSH's automation ACP replays nothing. */
  async readNativeHistory(ref: NativeSessionRef, window: HistoryWindow): Promise<NativeHistoryPage> {
    const host = this.hosts.at(-1)
    return host ? host.handle.readNativeHistory(ref, window) : { items: [] }
  }

  async open(target: OpenTarget, options: OpenOptions): Promise<DshSession> {
    await this.handover
    const cwd = target.kind === 'new' ? target.spec.cwd : (target.ref.locator ?? target.ref.cwd)
    const opened = await this.openOn(target, options)
    const session = new DshSession(this, options.sessionId, cwd, opened.inner, opened.route, this.options.moveLimit ?? 3)
    this.sessions.add(session)
    return session
  }

  /** @internal Open on the best route now: newest host first, past hosts that hold the lock; else direct. */
  async openOn(target: OpenTarget, options: OpenOptions): Promise<{ inner: RuntimeSession, route: Route }> {
    if (this.hosts.length) {
      let held: unknown
      for (const host of [...this.hosts].reverse()) {
        try { return { inner: await host.handle.open(target, options), route: { kind: 'plugin', host } } } catch (error) {
          if (!pluginWriterHeld(error)) throw error
          held = error
        }
      }
      throw new RuntimeFailure({ code: 'writer_held', retryable: true, message: (held as Error).message,
        details: { nativeSessionId: target.kind === 'existing' ? target.ref.nativeSessionId : '' } })
    }
    return { inner: await this.openDirect(target, options), route: { kind: 'direct' } }
  }

  private async openDirect(target: OpenTarget, options: OpenOptions): Promise<RuntimeSession> {
    const handle = this.direct()
    // DSH's automation ACP has no replay: history comes from the store (and the plugin).
    const attach = async (nativeSessionId: string, cwd: string | undefined) => {
      try { return await handle.open({ kind: 'existing', ref: { nativeSessionId, ...(cwd ? { locator: cwd } : {}) } }, { ...options, replay: 'none' }) } catch (error) {
        if (isWriterHeld(error)) throw new RuntimeFailure(writerHeld(nativeSessionId))
        throw error
      }
    }
    if (target.kind === 'existing') return attach(target.ref.nativeSessionId, target.ref.locator ?? target.ref.cwd)
    const ids = this.options.ids
    if (!ids) return handle.open(target, options)
    const { session } = await createDirectSession({
      list: async cwd => {
        const { client } = await handle.connection(cwd)
        const found: string[] = []
        let cursor: string | undefined
        for (let page = 0; page < 10; page++) {
          const result = asRecord(await client.request('session/list', { cwd, ...(cursor ? { cursor } : {}) }, { timeoutMs: 60_000 }))
          for (const item of Array.isArray(result.sessions) ? result.sessions.map(asRecord) : []) {
            if (item.cwd === cwd && typeof item.sessionId === 'string') found.push(item.sessionId)
          }
          if (typeof result.nextCursor !== 'string' || !result.nextCursor) break
          cursor = result.nextCursor
        }
        return found
      },
      attach,
      create: () => handle.open(target, options),
    }, ids, { platformSessionId: options.sessionId, cwd: target.spec.cwd })
    return session
  }

  /** @internal */
  forget(session: DshSession): void { this.sessions.delete(session) }

  /** @internal Whether a session that lost its route has somewhere to go. */
  get canMove(): boolean { return !this.stopped && (this.hosts.length > 0 || this.options.direct !== undefined) }

  async stop(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.sessions].map(session => session.close()))
    await Promise.allSettled([...this.hosts.map(host => host.handle.stop()), this.directHandle?.stop()])
    this.hosts.length = 0
    this.directHandle = undefined
    this.events.close()
  }
}

/**
 * A DSH session that stays open while its route changes. Calls made during a move wait for it;
 * events of every route it ran on arrive in order on one stream.
 */
export class DshSession implements RuntimeSession {
  readonly events = new EventQueue<RuntimeEvent>()
  readonly nativeSessionId: string
  private ready: Promise<void> = Promise.resolve()
  private release: (() => void) | undefined
  private closed = false
  private readonly moves: number[] = []
  private moving = false

  constructor(private readonly runtime: DshRuntime, readonly sessionId: string, private cwd: string | undefined,
    public inner: RuntimeSession, public route: Route, private readonly moveLimit: number) {
    this.nativeSessionId = inner.nativeSessionId
    void this.pump(inner)
  }

  get capabilities(): RuntimeCapabilities { return this.inner.capabilities }
  get routeKind(): DshRouteKind { return this.route.kind }
  get hostInstance(): string | undefined { return this.route.kind === 'plugin' ? this.route.host.hello.hostInstance : undefined }

  /** @internal New calls wait until the session has moved. */
  holdCalls(): void {
    if (!this.release) this.ready = new Promise(resolve => { this.release = resolve })
  }

  /** @internal Reopen on the best route now (the old one released the session or went away). */
  async move(): Promise<void> {
    if (this.closed || this.moving) return
    this.moving = true
    this.holdCalls()
    try {
      const now = Date.now()
      while (this.moves.length && now - this.moves[0]! > 60_000) this.moves.shift()
      this.moves.push(now)
      if (this.moves.length > this.moveLimit) throw new RuntimeFailure({ code: 'runtime_disconnected', retryable: true, message: 'DSH keeps going away; the session was not reopened.' })
      const opened = await this.runtime.openOn({ kind: 'existing', ref: { nativeSessionId: this.nativeSessionId, ...(this.cwd ? { locator: this.cwd } : {}) } },
        { sessionId: this.sessionId, replay: 'none' })
      this.inner = opened.inner
      this.route = opened.route
      void this.pump(opened.inner)
      this.events.push({ type: 'capabilities.changed', capabilities: opened.inner.capabilities })
    } catch (error) {
      this.events.push({ type: 'session.lost', error: runtimeError(error) })
      this.finish()
    } finally {
      this.moving = false
      const release = this.release
      this.release = undefined
      release?.()
    }
  }

  private async pump(inner: RuntimeSession): Promise<void> {
    for await (const event of inner.events) {
      if (event.type === 'session.lost') {
        if (this.closed || inner !== this.inner) return
        // The route went away (host quit, DSH crashed): the turn already ended "unknown"; move on.
        if (this.runtime.canMove) void this.move()
        else { this.events.push(event); this.finish() }
        return
      }
      this.events.push(event)
    }
  }

  private async current(): Promise<RuntimeSession> {
    await this.ready
    if (this.closed) throw new RuntimeFailure({ code: 'session_closed', message: 'The DSH session is closed.' })
    return this.inner
  }

  private problem(input: PromptInput): RuntimeError | undefined {
    return this.route.kind === 'direct' ? directPromptProblem(input) : pluginPromptProblem(input)
  }

  async prompt(input: PromptInput, delivery: DeliveryRef): Promise<PromptAcceptance> {
    if (this.closed) return { outcome: 'rejected', error: { code: 'session_closed', message: 'The DSH session is closed.' } }
    for (let attempt = 0; ; attempt++) {
      const inner = await this.current()
      const problem = this.problem(input)
      if (problem) return { outcome: 'rejected', error: problem }
      const result = await inner.prompt(input, delivery)
      // Rejected before anything ran because the route is being handed over: send it on the new one.
      if (result.outcome === 'rejected' && result.error.code === 'runtime_route_switching' && attempt < 2) {
        this.holdCalls()
        await this.ready
        continue
      }
      return result
    }
  }

  async steer(input: PromptInput, delivery: DeliveryRef): Promise<SteerResult> {
    const inner = await this.current()
    if (!inner.steer) return { outcome: 'rejected', error: { code: 'unsupported_operation', message: 'This DSH route cannot steer a running turn.' } }
    const problem = this.problem(input)
    if (problem) return { outcome: 'rejected', error: problem }
    return inner.steer(input, delivery)
  }

  /**
   * The session a running turn lives on. While a handover waits for that turn to end (`holdCalls`
   * before `move`), the turn and its pending interactions are still on the old route, and the
   * handover cannot finish until they are answered or cancelled: these calls must not wait for it.
   * Only once the move itself started (old route released) do they wait for the new one.
   */
  private async running(): Promise<RuntimeSession> {
    if (this.closed) throw new RuntimeFailure({ code: 'session_closed', message: 'The DSH session is closed.' })
    return this.moving ? this.current() : this.inner
  }

  async cancel(expectedTurnId?: string): Promise<void> { await (await this.running()).cancel(expectedTurnId) }
  async respond(interactionId: string, answer: InteractionAnswer): Promise<void | InteractionRefusal> {
    const inner = await this.running()
    // Only the plugin route can continue a failed turn; the direct route keeps the card for when a host returns.
    if (this.route.kind === 'direct' && isTurnFailureCard(interactionId)) {
      return { refused: { code: 'dsh_continue_unavailable', message: DIRECT_ROUTE_REASON }, closes: false }
    }
    return inner.respond(interactionId, answer)
  }
  async configure(change: ConfigChange): Promise<ConfigResult> { return (await this.current()).configure(change) }
  async command(name: string, args?: string): Promise<CommandResult> { return (await this.current()).command(name, args) }

  private finish(): void {
    this.closed = true
    this.runtime.forget(this)
    this.events.close()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.runtime.forget(this)
    if (this.moving) await this.ready.catch(() => undefined)
    else { const release = this.release; this.release = undefined; release?.() }
    await this.inner.close().catch(() => undefined)
    this.events.close()
  }
}
