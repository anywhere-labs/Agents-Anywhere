// Stand-ins for DSH 0.2.2-rc.3 over ACP. `FakeDshAcp` is one DSH process: the automation ACP the
// direct route starts (`dsh --profile acp`, S7: one prompt per session, empty prompts rejected,
// whole committed messages, random session IDs) or, with `plugin`, a DSH host running the AA
// plugin (AA chooses the native ID, items carry `_meta.dsh.itemId`). Processes share a `DshDisk`:
// the persisted sessions and DSH's per-session write lock.
import { PassThrough, Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { peerConnection, type ConnectionFactory } from '../../src/runtime/acp/handle.js'
import { AcpRuntimeHandle } from '../../src/runtime/acp/handle.js'
import type { AcpDialect } from '../../src/runtime/acp/dialect.js'
import { JsonRpcPeer, ndjsonTransport } from '../../src/runtime/acp/jsonrpc.js'
import { dshPluginDialect } from '../../src/runtime/profiles/dsh/plugin/dialect.js'
import type { DshHostHello, DshPluginRoute } from '../../src/runtime/profiles/dsh/plugin/route.js'

/** What every DSH process on the machine sees: persisted sessions and who holds each write lock. */
export class DshDisk {
  persisted: { sessionId: string, cwd: string }[] = [{ sessionId: 'cold-1', cwd: '/w' }]
  readonly locks = new Map<string, object>()
  /** Someone outside AA (DSH Desktop without the plugin) holds the session. */
  holdExternally(sessionId: string): void { this.locks.set(sessionId, {}) }
}

const itemOf = (text: string) => `dsh_${Buffer.from(text).toString('hex').padEnd(64, '0').slice(0, 64)}`

export class FakeDshAcp implements acp.Agent {
  conn!: acp.AgentSideConnection
  prompts: { sessionId: string, text: string }[] = []
  private running = new Map<string, () => void>()
  closed: string[] = []
  resumed: string[] = []
  gate: Promise<void> | undefined
  /** Ends the next prompt mid-way, as if the process died: the prompt never answers. */
  hangPrompts = false
  private nextId = 0
  /** Simulates DSH dying after it persisted a new session but before it answered. */
  dropNextNewSession = false

  constructor(readonly disk: DshDisk = new DshDisk(), readonly options: { plugin?: boolean, image?: boolean, name?: string } = {}) {}

  async initialize(): Promise<acp.InitializeResponse> {
    return { protocolVersion: 1, agentInfo: { name: this.options.plugin ? 'agents-anywhere-dsh' : 'deepseek-harness-acp', version: '0.0.1' },
      agentCapabilities: { loadSession: this.options.plugin === true, mcpCapabilities: { http: true },
        promptCapabilities: { image: this.options.image === true, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {}, list: {}, resume: {} } }, authMethods: [],
      ...(this.options.plugin ? { _meta: { dsh: { features: { steer: true, questions: true, attachments: true, planning: true } } } } : {}) }
  }
  async authenticate() {}
  private configOptions(): acp.SessionConfigOption[] {
    return [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: '["deepseek-official","deepseek-v4-flash"]',
      options: [{ group: 'deepseek-official', name: 'DeepSeek', options: [{ value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' }] }] },
    { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'high',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }]
  }
  private lock(sessionId: string): void {
    const holder = this.disk.locks.get(sessionId)
    if (holder && holder !== this) {
      // The plugin names the lock (contracts/dsh-bridge/3.0); the automation ACP only says "internal error" (S7).
      if (this.options.plugin) throw new acp.RequestError(-32000, 'The session is open in another DSH window.', { code: 'writer_held' })
      throw acp.RequestError.internalError()
    }
    this.disk.locks.set(sessionId, this)
  }
  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const wanted = (params._meta as { dsh?: { sessionId?: string } } | undefined)?.dsh?.sessionId
    const sessionId = this.options.plugin && wanted ? wanted : `uuid-${++this.nextId}`
    this.disk.persisted.unshift({ sessionId, cwd: params.cwd })
    if (this.dropNextNewSession) { this.dropNextNewSession = false; throw new Error('connection lost') }
    this.disk.locks.set(sessionId, this)
    return { sessionId, configOptions: this.configOptions() }
  }
  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    this.lock(params.sessionId)
    this.resumed.push(params.sessionId)
    return { configOptions: this.configOptions() }
  }
  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    return { configOptions: this.configOptions(), ...(params ? {} : {}) }
  }
  async closeSession(params: acp.CloseSessionRequest) {
    this.closed.push(params.sessionId)
    if (this.disk.locks.get(params.sessionId) === this) this.disk.locks.delete(params.sessionId)
    return {}
  }
  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    // The automation ACP hides sessions it has open itself (S7).
    return { sessions: this.disk.persisted.filter(item => (this.options.plugin || this.disk.locks.get(item.sessionId) !== this)
      && (!params.cwd || item.cwd === params.cwd)) }
  }
  async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    const options = this.configOptions().map(option => option.id === params.configId ? { ...option, currentValue: String((params as { value: unknown }).value) } : option)
    return { configOptions: options as acp.SessionConfigOption[] }
  }
  private message(sessionId: string, text: string, messageId: string) {
    return this.conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text },
      ...(this.options.plugin ? { _meta: { dsh: { itemId: itemOf(messageId), committed: {} } } } : {}) } })
  }
  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    if (this.running.has(params.sessionId)) throw acp.RequestError.invalidParams(undefined, 'a prompt is already running')
    const text = params.prompt.map(block => block.type === 'text' ? block.text : '').join('')
    if (!text.trim() && !params.prompt.some(block => block.type === 'image')) throw acp.RequestError.invalidParams(undefined, 'empty prompt')
    this.prompts.push({ sessionId: params.sessionId, text })
    if (this.hangPrompts) {
      await this.message(params.sessionId, 'working', `m-hang-${this.prompts.length}`)
      return new Promise(() => {})
    }
    let cancelled = false
    await new Promise<void>(resolve => {
      this.running.set(params.sessionId, () => { cancelled = true; resolve() })
      void (this.gate ?? Promise.resolve()).then(resolve)
    })
    this.running.delete(params.sessionId)
    if (cancelled) return { stopReason: 'cancelled' }
    if (text.includes('needs approval')) {
      const answer = await this.conn.requestPermission({ sessionId: params.sessionId,
        toolCall: { toolCallId: 'call-1', title: 'bash', status: 'pending', kind: 'other' },
        options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] })
      await this.message(params.sessionId, answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled', 'm-perm')
      return { stopReason: 'end_turn' }
    }
    await this.message(params.sessionId, `${this.options.name ?? 'dsh'} replies to ${text}`, `m-${this.prompts.length}`)
    return { stopReason: 'end_turn' }
  }
  async cancel(params: acp.CancelNotification) { this.running.get(params.sessionId)?.() }
  /** The process ends: DSH drops its write locks. */
  exit(): void {
    for (const [id, holder] of this.disk.locks) if (holder === this) this.disk.locks.delete(id)
    for (const stop of this.running.values()) stop()
  }
}

/** An in-memory ACP pipe to `fake`, as B's `peerConnection` sees a process or a socket. */
export function fakePipe(fake: FakeDshAcp) {
  const toAgent = new PassThrough()
  const toClient = new PassThrough()
  new acp.AgentSideConnection(conn => { fake.conn = conn; return fake },
    acp.ndJsonStream(Writable.toWeb(toClient) as WritableStream<Uint8Array>, Readable.toWeb(toAgent) as ReadableStream<Uint8Array>))
  const peer = new JsonRpcPeer(ndjsonTransport(toClient, toAgent))
  return { peer, kill: () => { fake.exit(); peer.close('DSH exited'); toAgent.destroy(); toClient.destroy() } }
}

/** The direct route's process factory over fake DSH processes on `disk`; `kill()` ends the current one. */
export function fakeDirect(dialect: AcpDialect, disk = new DshDisk(), options: { image?: boolean } = {}) {
  const state: { fake?: FakeDshAcp, kill?: () => void, starts: number } = { starts: 0 }
  const connect: ConnectionFactory = async () => {
    const fake = new FakeDshAcp(disk, { ...options, name: 'direct' })
    const pipe = fakePipe(fake)
    state.fake = fake
    state.kill = pipe.kill
    state.starts++
    return peerConnection(pipe.peer, dialect)()
  }
  return { disk, connect, state, get fake() { return state.fake! }, kill: () => state.kill?.() }
}

/** A DSH host with the AA plugin, as `dshPluginRoute` would build it from A's socket. */
export function fakeHost(disk: DshDisk, hello: Partial<DshHostHello> = {}, instanceId = 'rti_dsh') {
  const fake = new FakeDshAcp(disk, { plugin: true, image: true, name: hello.hostInstance ?? 'host-1' })
  const pipe = fakePipe(fake)
  const dialect = dshPluginDialect()
  const route: DshPluginRoute = {
    hello: { hostInstance: 'host-1', hostKind: 'desktop', dshVersion: '0.2.2-rc.3', pluginVersion: '3.0.0', ...hello },
    handle: new AcpRuntimeHandle({ type: 'dsh', instanceId, dialect, connect: peerConnection(pipe.peer, dialect), nativeInventory: true }),
    closed: pipe.peer.whenClosed(),
  }
  return { fake, route, disconnect: pipe.kill }
}
