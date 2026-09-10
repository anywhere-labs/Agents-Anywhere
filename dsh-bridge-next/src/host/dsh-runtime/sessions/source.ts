import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
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

  constructor(private ctx: Context, private diagnostics: RuntimeDiagnostics = quietDiagnostics) {
    this.archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
  }

  observe(session: Session, event?: SessionEvent): void {
    this.retry(session.id)
    // Retain the identity even if the session leaves memory before the feed consumes it.
    this.records.set(session.id, { header: session.header, live: true, persisted: this.records.get(session.id)?.persisted ?? false })
    if (event ? isUserMessage(event) : session.snapshotEvents().some(isUserMessage)) {
      this.withUserMessages.add(session.id)
      this.emptyLogs.delete(session.id)
    }
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    const previous = new Map(this.records)
    const entries = await this.diagnostics.measure('inventory.query', {}, () => this.ctx.sessionQuery.listSessions(signal))
    signal?.throwIfAborted()
    // Cheap per-log identities keep repeated visibility checks from re-reading
    // histories that did not change.
    this.revisions = await this.logRevisions(signal)
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
  }

  /** Identity of one log as observed by the last inventory; absent when it is not persisted. */
  revisionOf(id: string): string | undefined {
    const live = this.ctx.sessions.get(id as SessionId)
    if (live !== undefined) return `live:${live.snapshotEvents().at(-1)?.seq ?? -1}`
    return this.revisions.get(id)
  }

  /** Fresh identity of one log, including work that happened after the last inventory. */
  async freshRevisionOf(id: string): Promise<string | undefined> {
    const live = this.ctx.sessions.get(id as SessionId)
    if (live !== undefined) return `live:${live.snapshotEvents().at(-1)?.seq ?? -1}`
    return (await this.logRevisions()).get(id)
  }

  private async logRevisions(signal?: AbortSignal): Promise<Map<string, string>> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return new Map()
    try {
      const snapshots = await persistence.listSnapshots(signal)
      return new Map(snapshots.map(snapshot => [snapshot.header.id, String(snapshot.revision)]))
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted()
      // Revisions only accelerate reads; an unavailable backend must not fail inventory.
      this.diagnostics.log('warn', 'inventory.revision_failed', {}, error)
      return new Map()
    }
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
      const revision = this.revisionOf(id)
      // A blank verdict is cached only for the exact log it was read from: a
      // later first message changes that identity and forces a fresh read.
      if (revision === undefined || this.emptyLogs.get(id) !== revision) {
        let events: readonly SessionEvent[]
        try {
          events = live?.snapshotEvents() ?? (await this.diagnostics.measure('session.visibility_read', { sessionId: id }, () => this.ctx.sessionQuery.readSession(id as SessionId))).events
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
