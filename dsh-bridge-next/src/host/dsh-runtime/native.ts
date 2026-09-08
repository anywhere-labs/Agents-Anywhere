import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { freezeMessage, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot, SessionRecord } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { userMessageId } from './identity.js'
import { BridgeError } from './errors.js'
import { ClientPresence } from './visibility.js'
import { NativeSessionSource } from './sessions/source.js'
import { record } from './types.js'
import { UserQuestions } from './questions.js'
import { RuntimeDiagnostics } from './diagnostics.js'

export type NativeChange = { type: 'event', id: string, event: SessionEvent }
  | { type: 'session', id: string } | { type: 'status', id: string }
  | { type: 'refresh', id: string }
  | { type: 'question', id: string } | { type: 'capabilities' }
  | { type: 'visibility' }
export interface NativeWorkspace { id: string, title: string, path: string, sessionIds: string[] }

/** All native interpretation stays in the Host; observers never await transport work. */
export class NativeRuntime {
  readonly presence: ClientPresence
  readonly questions: UserQuestions
  private listeners = new Set<(change: NativeChange) => void>()
  readonly source: NativeSessionSource
  private owned = new Set<AgentHandle>()
  private writes = new Map<string, Promise<unknown>>()
  private closed = false

  constructor(readonly ctx: Context, readonly diagnostics = new RuntimeDiagnostics(ctx.logger('agents-anywhere-runtime'))) {
    this.presence = new ClientPresence(() => this.emit({ type: 'visibility' }))
    this.source = new NativeSessionSource(ctx, diagnostics)
    this.questions = new UserQuestions(ctx, id => this.visible(id), id => this.emit(id ? { type: 'question', id } : { type: 'capabilities' }))
    ctx.on('session/created', session => {
      this.source.observe(session)
      this.emit({ type: 'session', id: session.id })
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      this.source.observe(session, event)
      this.questions.observe(session.id, event)
      this.emit({ type: 'event', id: session.id, event })
    }, { global: true })
    ctx.on('session/disposed', session => this.emit({ type: 'session', id: session.id }), { global: true })
    ctx.on('agent/status', ({ agent }) => this.emit({ type: 'status', id: agent.id }), { global: true })
    ctx.on('domain/changed', change => {
      if (change.domain !== 'workspace') return
      if (change.table === '' && change.operation === 'put') {
        const ids = record(change.value).archivedSessionIds
        if (Array.isArray(ids)) {
          const next = new Set(ids.filter((id): id is string => typeof id === 'string'))
          if (next.size !== this.source.archived.size || [...next].some(id => !this.source.archived.has(id))) {
            this.source.archived = next
            this.emit({ type: 'visibility' })
          }
        }
      }
    })
  }

  watch(callback: (change: NativeChange) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }
  refresh(id: string): void { this.source.retry(id); this.emit({ type: 'refresh', id }) }
  private emit(change: NativeChange): void {
    for (const listener of this.listeners) {
      try { listener(change) } catch { /* Feed owns its error/recovery channel. */ }
    }
  }
  workspaces(): NativeWorkspace[] {
    return this.ctx.workspaceRegistry.list().map(w => ({ id: w.id, title: w.title, path: w.path, sessionIds: [...w.sessionIds] }))
  }
  status(id: SessionId): 'idle' | 'running' | undefined { return this.ctx.get('agents')?.get(id)?.status }
  candidates(): string[] { return this.source.candidates() }
  async inventory(signal?: AbortSignal): Promise<SessionRecord[]> {
    await this.source.refresh(signal)
    const result: SessionRecord[] = []
    // Concurrent detail reads may refresh the source map while visibility awaits I/O.
    // Capture this inventory once so pagination cannot repeat reinserted records.
    for (const entry of [...this.source.records.values()]) {
      signal?.throwIfAborted()
      if (await this.visible(entry.header.id)) result.push(entry)
    }
    this.diagnostics.log('info', 'inventory.completed', { candidates: this.source.records.size, visible: result.length, archived: this.source.archived.size })
    return result
  }
  visible(id: string): Promise<boolean> { return this.source.visible(id) }
  async read(id: SessionId): Promise<SessionLogSnapshot> {
    await this.source.requireAvailable(id)
    let snapshot: SessionLogSnapshot
    try {
      snapshot = await this.diagnostics.measure('session.read', { sessionId: id }, () => this.ctx.sessionQuery.readSession(id))
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) this.source.markReadFailed(id)
      throw error
    }
    await this.source.requireAvailable(id)
    return snapshot
  }

  async send(id: SessionId, text: string, requestId: string, cwd?: string, create = false): Promise<void> {
    if (!text.trim() || text.length > 1_000_000 || !requestId || requestId.length > 512) {
      throw new BridgeError('INVALID_PARAMS', 'A text message and stable client message ID are required.')
    }
    const previous = this.writes.get(id) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      if (this.closed) throw new Error('DSH runtime is disposed')
      // Re-read the official catalog on every send, including after a stale AA detail view.
      await this.source.refresh()
      if (!create || this.source.archived.has(id)) await this.source.requireAvailable(id)
      const agents = this.ctx.get('agents')
      if (!agents) throw new BridgeError('UNSUPPORTED_OPERATION', 'DSH Agent service is not available.')
      let agent = agents.get(id)
      // A failed storage read must never be mistaken for a new session.
      const exists = agent || !create || (await this.ctx.sessionQuery.listSessions()).some(r => r.header.id === id)
      const log = agent ? { session: agent.session.header, events: agent.session.snapshotEvents() }
        : exists ? await this.ctx.sessionQuery.readSession(id) : undefined
      if (create && log && (log.session.origin === 'subagent' || this.source.archived.has(id))) throw new BridgeError('SESSION_NOT_FOUND', 'The session is not visible in DSH.')
      if (!create && !await this.visible(id)) throw new BridgeError('SESSION_NOT_FOUND', 'The session is not visible in DSH.')
      const messageId = userMessageId(id, requestId) as UserMessage['id']
      // Inbox acceptance is durable too, before user/message is appended by the driver.
      const accepted = log?.events.some(event => event.type === 'user/message' ? event.data.id === messageId
        : event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === messageId))
      if (accepted) return
      if (!agent) {
        const headerEvent = log?.events.findLast(e => e.type === 'request/header')
        const loggedConfig = record(record(headerEvent?.data).header).config
        const route = loggedConfig ? record(loggedConfig) : this.ctx.get('agentDefaultModel')?.currentSelection()
        if (!route || typeof route.provider !== 'string' || !route.provider || typeof route.model !== 'string' || !route.model) {
          throw new BridgeError('INVALID_PARAMS', '请先在 DSH 中配置默认模型。')
        }
        const agentOptions = { provider: route.provider, model: route.model,
          ...(typeof route.reasoningEffort === 'string' ? { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } : {}) }
        const lastPreset = log?.events.findLast(e => e.type === 'agent-preset/selected')
        const presetId = lastPreset?.type === 'agent-preset/selected' ? lastPreset.data.agentPreset : log?.session.agentPreset
        const presets = this.ctx.get('agentPresets')
        const preset = presets ? await presets.resolve(presetId) : undefined
        const setup = preset && presets ? async (scope: Context) => { await presets.mount(scope, preset.id) } : undefined
        let path: string | undefined
        if (!log) {
          if (!cwd || !isAbsolute(cwd)) throw new BridgeError('INVALID_PARAMS', 'Choose an absolute workspace directory.')
          path = await realpath(cwd)
          if (!(await stat(path)).isDirectory()) throw new BridgeError('INVALID_PARAMS', 'The workspace must be a directory.')
        }
        try {
          const handle = log ? await agents.resume({ resumeSessionId: id, agentOptions, ...(setup ? { setup } : {}) })
            : await agents.create({ sessionId: id, agentOptions, meta: { cwd: path!, ...(preset ? { agentPreset: preset.id } : {}) }, ...(setup ? { setup } : {}) })
          this.owned.add(handle)
          agent = handle.agent
        } catch (error) {
          // The Desktop may have resumed the same native session during setup.
          agent = agents.get(id)
          if (!agent) throw error
        }
        if (path) {
          const workspace = await this.ctx.workspaceRegistry.create(path)
          await workspace.attachSession(id)
        }
      }
      if (this.source.archived.has(id)) await this.source.requireAvailable(id)
      if (this.closed || (!create && !await this.visible(id))) {
        throw new BridgeError('SESSION_NOT_FOUND', 'The session is no longer visible in DSH.')
      }
      const message = freezeMessage<UserMessage>({ id: messageId, role: 'user',
        source: { kind: 'user' }, content: [{ type: 'text', text }] })
      agent.followup(message)
      await this.ctx.sessions.flush(agent.session)
    })
    this.writes.set(id, task)
    try { await task } finally { if (this.writes.get(id) === task) this.writes.delete(id) }
  }
  async interrupt(id: SessionId): Promise<void> {
    await this.source.requireAvailable(id)
    this.ctx.get('agents')?.get(id)?.cancel({ kind: 'user' })
  }
  async close(): Promise<void> {
    this.closed = true
    this.presence.close()
    await this.questions.close()
    this.listeners.clear()
    await Promise.allSettled([...this.writes.values()])
    await Promise.allSettled([...this.owned].map(handle => handle.dispose()))
  }
}
