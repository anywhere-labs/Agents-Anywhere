import type { Context } from '@deepseek-ai/cordis'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { canonicalJson, digest, userMessageId } from './identity.js'
import { BridgeError } from './errors.js'
import { ClientPresence } from './visibility.js'
import { NativeSessionSource } from './sessions/source.js'
import { record } from './types.js'
import { UserQuestions } from './questions.js'
import { RuntimeDiagnostics } from './diagnostics.js'
import { RuntimeCatalogs } from './catalogs.js'
import { RuntimeConfiguration } from './configuration.js'
import type { Selections } from './selections.js'
import { capabilities } from './capabilities.js'
import { CreationIntents } from './creation-intents.js'
import { RuntimeImages, imageFingerprint, imageReferences, type AttachmentSnapshot, type StagedImage } from './attachments.js'
declare module '@deepseek-ai/cordis' {
  interface Events { 'llm/adapters-updated'(): void }
}

export type NativeChange = { type: 'event', id: string, event: SessionEvent }
  | { type: 'session', id: string } | { type: 'status', id: string }
  | { type: 'refresh', id: string }
  | { type: 'question', id: string } | { type: 'capabilities' }
  | { type: 'visibility' } | { type: 'catalogs' }
export interface NativeWorkspace { id: string, title: string, path: string, sessionIds: string[] }

/** Configuration facts a session state read needs, without retaining the event log. */
export interface SessionFacts {
  configuration: Awaited<ReturnType<RuntimeConfiguration['state']>>
  lastTurnEndKind: string | undefined
}

/** Last terminal turn outcome, which decides a cold session's status. */
export function lastTurnEndKind(events: readonly SessionEvent[]): string | undefined {
  const last = events.findLast(event => event.type === 'turn/end')
  return last?.type === 'turn/end' ? last.data.reason.kind : undefined
}

/** All native interpretation stays in the Host; observers never await transport work. */
export class NativeRuntime {
  readonly presence: ClientPresence
  readonly questions: UserQuestions
  private listeners = new Set<(change: NativeChange) => void>()
  readonly source: NativeSessionSource
  readonly catalogs: RuntimeCatalogs
  readonly configuration: RuntimeConfiguration
  private writes = new Map<string, Promise<unknown>>()
  private closed = false
  private creations: CreationIntents
  readonly images: RuntimeImages
  // Successful feed checkpoints live only for this Host process. A new Host imports everything.
  private readonly syncCheckpoints = new Map<string, Map<string, string>>()
  checkpoints(namespace: string): Map<string, string> {
    let checkpoints = this.syncCheckpoints.get(namespace)
    if (!checkpoints) { checkpoints = new Map(); this.syncCheckpoints.set(namespace, checkpoints) }
    return checkpoints
  }
  private readonly facts = new Map<string, { revision: string, value: SessionFacts }>()

  constructor(readonly ctx: Context, creationDirectory: string,
    readonly diagnostics = new RuntimeDiagnostics(ctx.logger('agents-anywhere-runtime'))) {
    this.creations = new CreationIntents(creationDirectory)
    this.images = new RuntimeImages(join(dirname(creationDirectory), 'attachments'))
    this.catalogs = new RuntimeCatalogs(ctx, () => this.emit({ type: 'catalogs' }))
    this.configuration = new RuntimeConfiguration(ctx)
    ctx.on('llm/adapters-updated', () => this.catalogs.invalidate(), { global: true })
    for (const key of ['sessionController', 'permissionPresets', 'commands', 'agentPresets', 'attachments'] as const) {
      ctx.inject([key], child => {
        this.emit({ type: 'capabilities' })
        child.effect(() => () => this.emit({ type: 'capabilities' }), 'runtime.configuration-capabilities')
      })
    }
    this.presence = new ClientPresence(() => {})
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
  refresh(id: string): void {
    for (const checkpoints of this.syncCheckpoints.values()) checkpoints.delete(id)
    this.source.retry(id); this.emit({ type: 'refresh', id })
  }
  private emit(change: NativeChange): void {
    for (const listener of this.listeners) {
      try { listener(change) } catch { /* Feed owns its error/recovery channel. */ }
    }
  }
  workspaces(): NativeWorkspace[] {
    return this.ctx.workspaceRegistry.list().map(w => ({ id: w.id, title: w.title, path: w.path, sessionIds: [...w.sessionIds] }))
  }
  status(id: SessionId): 'idle' | 'running' | undefined { return this.ctx.get('agents')?.get(id)?.status }
  async capabilities(platformId?: string, id?: SessionId) {
    let model = false
    let catalog: Awaited<ReturnType<RuntimeCatalogs['models']>> | undefined
    if (this.configuration.canSelectModel) {
      try { catalog = await this.catalogs.models(); model = catalog.metadata.routableProviders.length > 0 }
      catch (error) { this.diagnostics.log('error', 'capabilities.model_catalog_failed', {}, error) }
    }
    // This capability covers the model selector, including switching to another
    // model. Each model's reasoningItems describes its own effort support.
    const effort = Boolean(catalog?.models.some(item => item.enabled && item.reasoningItems.some(option => option.enabled)))
    const result = capabilities(platformId, Boolean(this.ctx.get('sessionController')), this.questions.available,
      { model, effort, attachments: Boolean(this.ctx.get('attachments')),
        permission: this.configuration.canSelectPermission && (!id || !this.ctx.get('agents')?.get(id) || Boolean(this.ctx.get('commands')!.find(this.ctx.get('agents')!.get(id)!, 'permission'))) })
    return { ...result, metadata: { ...result.metadata,
      ...(catalog ? { modelCatalogFailures: catalog.metadata.failures } : {}) } }
  }
  candidates(): string[] { return this.source.candidates() }
  async inventory(signal?: AbortSignal, visit?: (entry: SessionRecord) => Promise<void>): Promise<SessionRecord[]> {
    await this.source.initialize(signal)
    const result: SessionRecord[] = []
    // Concurrent detail reads may refresh the source map while visibility awaits I/O.
    // Capture this inventory once so pagination cannot repeat reinserted records.
    for (const entry of [...this.source.records.values()]) {
      signal?.throwIfAborted()
      if (await this.visible(entry.header.id)) {
        result.push(entry)
        await visit?.(entry)
      }
    }
    this.diagnostics.log('info', 'inventory.completed', { candidates: this.source.records.size, visible: result.length, archived: this.source.archived.size })
    return result
  }
  visible(id: string): Promise<boolean> { return this.source.visible(id) }
  /** Resolve the startup inventory once; native events maintain it afterwards. */
  async ensureKnown(id: string, signal?: AbortSignal): Promise<void> {
    if (this.source.records.has(id) || this.ctx.sessions.get(id as SessionId) !== undefined) return
    await this.source.initialize(signal)
  }
  /**
   * Read the configuration facts of one session.
   *
   * Replaying a large session log is expensive and owned by DSH, so facts derived
   * from an unchanged log are reused. The key is the log identity, never wall time,
   * and nothing but the derived facts is retained.
   */
  async stateFacts(id: SessionId): Promise<SessionFacts> {
    const revision = await this.source.freshRevisionOf(id)
    if (revision !== undefined) {
      const cached = this.facts.get(id)
      if (cached !== undefined && cached.revision === revision) return cached.value
    }
    const live = this.ctx.sessions.get(id)
    const snapshot = live !== undefined ? undefined : await this.source.readLog(id)
    const configuration = await this.configuration.state(id, snapshot)
    const events = live?.snapshotEvents() ?? snapshot!.events
    const value: SessionFacts = {
      configuration,
      lastTurnEndKind: lastTurnEndKind(events),
    }
    if (revision !== undefined) {
      this.facts.delete(id); this.facts.set(id, { revision, value })
    }
    return value
  }
  async read(id: SessionId): Promise<AttachmentSnapshot> {
    await this.source.requireAvailable(id)
    let snapshot: AttachmentSnapshot
    try {
      snapshot = await this.diagnostics.measure('session.read', { sessionId: id }, async () => ({
        ...await this.source.readLog(id), attachmentReceipts: await this.images.readReceipts(id),
      }))
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) this.source.markReadFailed(id)
      throw error
    }
    await this.source.requireAvailable(id)
    return snapshot
  }

  async send(id: SessionId, text: string, requestId: string, cwd?: string, create = false,
    selections: Selections = {}, agentPreset?: string, signal = new AbortController().signal,
    images: readonly StagedImage[] = [], platformId?: string): Promise<void> {
    if ((!text.trim() && !images.length) || text.length > 1_000_000 || !requestId || requestId.length > 512) {
      throw new BridgeError('INVALID_PARAMS', 'A text message and stable client message ID are required.')
    }
    await this.write(id, signal, async () => {
      await this.source.initialize(signal)
      if (!create || this.source.archived.has(id)) await this.source.requireAvailable(id)
      const live = this.ctx.get('agents')?.get(id)
      const exists = live || !create || this.source.records.has(id)
      const log = live ? { session: live.session.header, events: live.session.snapshotEvents() }
        : exists ? await this.source.readLog(id) : undefined
      if (create && log && (log.session.origin === 'subagent' || this.source.archived.has(id))) throw new BridgeError('SESSION_NOT_FOUND', 'The session is not visible in DSH.')
      if (!create && !await this.visible(id)) throw new BridgeError('SESSION_NOT_FOUND', 'The session is not visible in DSH.')
      const messageId = userMessageId(id, requestId)
      const receipt = (await this.images.readReceipts(id))[messageId]
      if (receipt && (receipt.fingerprint !== imageFingerprint(text, images) || receipt.platformId !== platformId)) {
        throw new BridgeError('INVALID_PARAMS', 'This message ID was already used with different attachments.')
      }
      let path: string | undefined
      let fingerprint: string | undefined
      const intent = create ? await this.creations.read(id) : null
      if (create) {
        if (!cwd || !isAbsolute(cwd)) throw new BridgeError('INVALID_PARAMS', 'Choose an absolute workspace directory.')
        try {
          path = await realpath(cwd)
          if (!(await stat(path)).isDirectory()) throw new Error('not a directory')
        } catch { throw new BridgeError('INVALID_PARAMS', 'The workspace must be an accessible directory on the DSH device.') }
        fingerprint = digest(canonicalJson({ requestId, content: text, cwd: path, agentPreset: agentPreset ?? null,
          model: selections.model ?? null, permission: selections.permission ?? null,
          ...(images.length ? { attachments: imageReferences(images).map(image => ({ ...image })) } : {}) }))
        if (intent && (intent.requestId !== requestId || intent.fingerprint !== fingerprint)) {
          throw new BridgeError('INVALID_PARAMS', 'This session was created with different initialization parameters.')
        }
        if (log && log.session.cwd !== path) throw new BridgeError('INVALID_PARAMS', 'The session already uses a different workspace.')
      }
      // Admission is durable before the loop records user/message. Retrying never resets configuration.
      const isAcceptedMessage = (message: { id: string, source: unknown }) => message.id === messageId || record(message.source).rpcId === messageId
      const accepted = log?.events.some(event => event.type === 'user/message' ? isAcceptedMessage(event.data)
        : event.type === 'agent/inbox/spliced' && event.data.inserted.some(isAcceptedMessage))
      if (accepted) {
        if (images.length && !receipt) throw new BridgeError('INVALID_PARAMS', 'This message ID was already accepted without attachments.')
        return
      }
      const store = this.ctx.get('attachments')
      if (images.length && (!store || !platformId)) throw new BridgeError('UNSUPPORTED_OPERATION', 'DSH image attachments are unavailable.')
      const imageParts = images.length ? await this.images.prepare(images, store!, signal) : []
      await this.configuration.validate(selections, create)
      if (create) {
        if (log?.events.some(event => event.type === 'turn/start')) throw new BridgeError('INVALID_PARAMS', 'This session has already started. Continue it with a new message.')
        const preset = await this.configuration.validatePreset(agentPreset)
        if (!intent) await this.creations.write(id, { requestId, fingerprint: fingerprint! })
        await this.configuration.controller().create({ sessionId: id, cwd: path!, agentPreset: preset })
        const workspace = await this.ctx.workspaceRegistry.create(path!)
        await workspace.attachSession(id)
      }
      const agent = await this.configuration.agent(id)
      await this.configuration.apply(agent, selections, create, signal)
      if (this.source.archived.has(id)) await this.source.requireAvailable(id)
      if (this.closed || (!create && !await this.visible(id))) throw new BridgeError('SESSION_NOT_FOUND', 'The session is no longer visible in DSH.')
      if (images.length && !receipt) await this.images.remember(id, messageId, {
        platformId: platformId!, fingerprint: imageFingerprint(text, images), attachments: imageReferences(images),
      })
      await this.configuration.controller().prompt({ sessionId: id, requestId: messageId as SessionPromptRequest['requestId'],
        mode: 'queue', content: [...(text ? [{ type: 'text' as const, text }] : []), ...imageParts] }, signal)
      await this.ctx.sessions.flush(agent.session)
    })
  }

  async updateSelections(id: SessionId, selections: Selections, signal: AbortSignal) {
    return this.write(id, signal, async () => {
      await this.source.initialize(signal)
      await this.source.requireAvailable(id)
      await this.configuration.validate(selections)
      const agent = await this.configuration.agent(id)
      try { await this.configuration.apply(agent, selections, false, signal) }
      finally { this.emit({ type: 'status', id }) }
      return this.configuration.state(id)
    })
  }

  /** Hold admission only; no operation waits for an Agent turn to finish. */
  private async write<T>(id: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(id) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(() => {
      signal.throwIfAborted()
      if (this.closed) throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'DSH bridge is closing.', true)
      return operation()
    })
    this.writes.set(id, task)
    try { return await task } finally { if (this.writes.get(id) === task) this.writes.delete(id) }
  }
  async interrupt(id: SessionId): Promise<void> {
    await this.source.requireAvailable(id)
    this.ctx.get('agents')?.get(id)?.cancel({ kind: 'user' })
  }
  async close(): Promise<void> {
    this.closed = true
    this.presence.close()
    this.source.close()
    await this.questions.close()
    this.listeners.clear()
    await Promise.allSettled([...this.writes.values()])
    this.facts.clear()
    this.syncCheckpoints.clear()
  }
}
