import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation, SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import { BridgeError } from '../errors.js'
import { isUserMessage, sessionVisible } from '../visibility.js'
import { quietDiagnostics, type RuntimeDiagnostics } from '../diagnostics.js'

export interface SourceState {
  availability: 'available' | 'archived' | 'unavailable' | 'missing'
  reason: string | null
  observedAt: string
}

/** The official query includes persisted sessions; absence from memory is not archival. */
export class NativeSessionSource {
  archived: Set<string>
  private readonly withUserMessages = new Set<string>()
  /** Log identity of a read that found no user message; a changed log invalidates it. */
  private readonly emptyLogs = new Map<string, string>()
  private readonly failedReads = new Set<string>()
  readonly records = new Map<string, SessionRecord>()
  private revisions = new Map<string, string>()
  private initialized = false
  private refreshing: Promise<void> | undefined
  private readonly logs = new Map<string, { revision: string, observation: SessionObservation }>()
  private readonly reads = new Map<string, Promise<SessionLogSnapshot & { bridgeRevision?: string }>>()
  private closed = false

  async initialize(signal?: AbortSignal): Promise<void> {
    if (!this.initialized) await this.refresh(signal)
    signal?.throwIfAborted()
  }

  private evict(id: string): void {
    const cached = this.logs.get(id)
    if (!cached) return
    this.logs.delete(id)
    cached.observation[Symbol.dispose]()
  }

  close(): void {
    this.closed = true
    for (const id of this.logs.keys()) this.evict(id)
  }

  /** Borrow an immutable SDK cut: no corpus preflight, replay clone or JSON round trip. */
  async readLog(id: SessionId): Promise<SessionLogSnapshot & { bridgeRevision?: string }> {
    const pending = this.reads.get(id)
    if (pending) return pending
    const task = this.loadLog(id)
    this.reads.set(id, task)
    try { return await task }
    finally { if (this.reads.get(id) === task) this.reads.delete(id) }
  }

  private async loadLog(id: SessionId): Promise<SessionLogSnapshot & { bridgeRevision?: string }> {
    const revision = await this.freshRevisionOf(id)
    let cached = this.logs.get(id)
    if (cached && cached.revision !== revision) { this.evict(id); cached = undefined }
    let observation = cached?.observation
    if (!observation) observation = await this.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
    try {
      // Shallow array ownership only; SDK observation events are immutable.
      const actualRevision = observation.source === 'live' ? `live:${observation.cursor}` : revision
      const log = { ...(actualRevision === undefined ? {} : { bridgeRevision: actualRevision }), session: observation.header, inheritedEventCount: observation.inheritedEventCount,
        events: [...observation.events] }
      if (!cached && !this.closed && actualRevision !== undefined) {
        // Do not associate a newer live cut with an older event cursor.
        this.logs.set(id, { revision: actualRevision, observation: observation.retain() })
      }
      return log
    } finally { if (!cached) observation[Symbol.dispose]() }
  }

  constructor(private ctx: Context, private diagnostics: RuntimeDiagnostics = quietDiagnostics) {
    this.archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
  }

  observe(session: Session, event?: SessionEvent): void {
    this.evict(session.id)
    this.retry(session.id)
    // Retain the identity even if the session leaves memory before the feed consumes it.
    this.records.set(session.id, { header: session.header, live: true, persisted: this.records.get(session.id)?.persisted ?? false })
    if (event ? isUserMessage(event) : session.snapshotEvents().some(isUserMessage)) {
      this.withUserMessages.add(session.id)
      this.emptyLogs.delete(session.id)
    }
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    // All callers share one refresh; one caller's cancellation cannot cancel other readers.
    this.refreshing ??= this.refreshRecords().finally(() => { this.refreshing = undefined })
    await this.refreshing
    signal?.throwIfAborted()
  }

  private async refreshRecords(signal?: AbortSignal): Promise<void> {
    const previous = new Map(this.records)
    const entries = await this.diagnostics.measure('inventory.query', {}, () => this.ctx.sessionQuery.listSessions(signal))
    signal?.throwIfAborted()
    // Explicit refresh invalidates retained observations; routine reads use initialize().
    this.revisions.clear()
    for (const id of this.logs.keys()) this.evict(id)
    // A new inventory is an explicit opportunity to retry transient failures.
    this.failedReads.clear()
    const listed = new Set<string>(entries.map(entry => entry.header.id))
    // A catalog captured before a new session's events must not erase those events' identity.
    for (const [id, entry] of previous) {
      if (this.records.get(id) === entry && !listed.has(id) && !this.ctx.sessions.get(id as SessionId)) {
        this.records.delete(id)
        this.withUserMessages.delete(id)
        this.emptyLogs.delete(id)
      }
    }
    for (const entry of entries) {
      const current = this.records.get(entry.header.id)
      if (!current || current === previous.get(entry.header.id)) this.records.set(entry.header.id, entry)
    }
    this.archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds)
    this.initialized = true
  }

  /** Identity of one log as observed by the last inventory; absent when it is not persisted. */
  revisionOf(id: string): string | undefined {
    const live = this.ctx.sessions.get(id as SessionId)
    if (live !== undefined) return `live:${Number(live.seq) - 1}`
    return this.revisions.get(id)
  }

  /** Fresh identity of one log, including work that happened after the last inventory. */
  async freshRevisionOf(id: string): Promise<string | undefined> {
    const live = this.ctx.sessions.get(id as SessionId)
    if (live !== undefined) return `live:${Number(live.seq) - 1}`
    try {
      const snapshot = await this.ctx.get('sessionPersistence')?.stat(id as SessionId)
      if (!snapshot) { this.revisions.delete(id); return undefined }
      const revision = String(snapshot.revision)
      this.revisions.set(id, revision)
      return revision
    } catch { this.revisions.delete(id); return undefined }
  }

  candidates(): string[] { return [...new Set([...this.records.keys(), ...this.archived])] }
  retry(id: string): void { this.failedReads.delete(id) }
  markReadFailed(id: string): void {
    this.failedReads.add(id)
    this.diagnostics.log('warn', 'session.read_unavailable', { sessionId: id, reason: 'read_failed' })
  }

  async visible(id: string): Promise<boolean> {
    const live = this.ctx.sessions.get(id as SessionId)
    const header = live?.header ?? this.records.get(id)?.header
    if (!header || header.origin === 'subagent' || this.archived.has(id)) return false
    if (this.failedReads.has(id)) return false
    if (!this.withUserMessages.has(id)) {
      if (!live && this.records.get(id)?.persisted === false) return false
      const revision = await this.freshRevisionOf(id)
      // A blank verdict is cached only for the exact log it was read from: a
      // later first message changes that identity and forces a fresh read.
      if (revision === undefined || this.emptyLogs.get(id) !== revision) {
        let events: readonly SessionEvent[]
        try {
          events = live?.snapshotEvents() ?? (await this.diagnostics.measure('session.visibility_read', { sessionId: id }, () => this.readLog(id as SessionId))).events
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error
          // One unreadable history must not take down inventory or the event stream.
          this.markReadFailed(id)
          return false
        }
        if (events.some(isUserMessage)) {
          this.withUserMessages.add(id)
          this.emptyLogs.delete(id)
        } else if (revision !== undefined) {
          this.emptyLogs.set(id, revision)
        }
      }
    }
    return sessionVisible({ id, ...(header.origin ? { origin: header.origin } : {}), hasUserMessage: this.withUserMessages.has(id) }, this.archived)
  }

  async state(id: string): Promise<SourceState> {
    const observedAt = new Date().toISOString()
    // Only the authoritative archive set establishes an archived fact.
    if (this.archived.has(id)) return { availability: 'archived', reason: 'archived_in_dsh', observedAt }
    if (!this.records.has(id) && !this.ctx.sessions.get(id as SessionId)) {
      return { availability: 'missing', reason: 'not_found_in_dsh', observedAt }
    }
    return await this.visible(id) ? { availability: 'available', reason: null, observedAt }
      : { availability: 'unavailable', reason: this.failedReads.has(id) ? 'read_failed' : 'not_visible_in_dsh', observedAt }
  }

  async requireAvailable(id: string): Promise<void> {
    const state = await this.state(id)
    if (state.availability === 'archived') throw new BridgeError('SESSION_ARCHIVED', '该会话已在 DeepSeek Harness 客户端中归档，请取消归档后继续。')
    if (state.reason === 'read_failed') throw new BridgeError('PERSISTENCE_ERROR', 'DSH could not read this session. Check the Bridge logs page and retry after repairing its native history.', true)
    if (state.availability !== 'available') throw new BridgeError('SESSION_NOT_FOUND', 'The session is not visible in DSH.')
  }
}
