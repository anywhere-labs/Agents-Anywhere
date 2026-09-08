import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
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
  readonly records = new Map<string, SessionRecord>()

  constructor(private ctx: Context, private diagnostics: RuntimeDiagnostics = quietDiagnostics) {
    this.archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
  }

  observe(session: Session, event?: SessionEvent): void {
    // Retain the identity even if the session leaves memory before the feed consumes it.
    this.records.set(session.id, { header: session.header, live: true, persisted: this.records.get(session.id)?.persisted ?? false })
    if (event ? isUserMessage(event) : session.snapshotEvents().some(isUserMessage)) this.withUserMessages.add(session.id)
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    const previous = new Map(this.records)
    const entries = await this.diagnostics.measure('inventory.query', {}, () => this.ctx.sessionQuery.listSessions(signal))
    signal?.throwIfAborted()
    const listed = new Set<string>(entries.map(entry => entry.header.id))
    // A catalog captured before a new session's events must not erase those events' identity.
    for (const [id, entry] of previous) {
      if (this.records.get(id) === entry && !listed.has(id) && !this.ctx.sessions.get(id as SessionId)) {
        this.records.delete(id)
        this.withUserMessages.delete(id)
      }
    }
    for (const entry of entries) {
      const current = this.records.get(entry.header.id)
      if (!current || current === previous.get(entry.header.id)) this.records.set(entry.header.id, entry)
    }
    this.archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds)
  }

  candidates(): string[] { return [...new Set([...this.records.keys(), ...this.archived])] }

  async visible(id: string): Promise<boolean> {
    const live = this.ctx.sessions.get(id as SessionId)
    const header = live?.header ?? this.records.get(id)?.header
    if (!header || header.origin === 'subagent' || this.archived.has(id)) return false
    if (!this.withUserMessages.has(id)) {
      if (!live && this.records.get(id)?.persisted === false) return false
      const events = live?.snapshotEvents() ?? (await this.diagnostics.measure('session.visibility_read', { sessionId: id }, () => this.ctx.sessionQuery.readSession(id as SessionId))).events
      // Cache positive evidence only: an earlier blank read must not hide a later first message.
      if (events.some(isUserMessage)) this.withUserMessages.add(id)
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
      : { availability: 'unavailable', reason: 'not_visible_in_dsh', observedAt }
  }

  async requireAvailable(id: string): Promise<void> {
    const state = await this.state(id)
    if (state.availability === 'archived') throw new BridgeError('SESSION_ARCHIVED', '该会话已在 DeepSeek Harness 客户端中归档，请取消归档后继续。')
    if (state.availability !== 'available') throw new BridgeError('SESSION_NOT_FOUND', 'The session is not visible in DSH.')
  }
}
