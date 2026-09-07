import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import { BridgeError } from '../errors.js'
import { sessionVisible, type ClientPresence } from '../visibility.js'

export interface SourceState {
  availability: 'available' | 'archived' | 'unavailable' | 'missing'
  reason: string | null
  observedAt: string
}

/** The official query includes persisted sessions; absence from memory is not archival. */
export class NativeSessionSource {
  archived: Set<string>
  readonly turns = new Map<string, boolean>()
  readonly records = new Map<string, SessionRecord>()

  constructor(private ctx: Context, private presence: ClientPresence) {
    this.archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    const entries = await this.ctx.sessionQuery.listSessions(signal)
    signal?.throwIfAborted()
    for (const id of this.records.keys()) {
      if (!this.ctx.sessions.get(id as SessionId)) this.records.delete(id)
    }
    for (const entry of entries) this.records.set(entry.header.id, entry)
    this.archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds)
  }

  candidates(): string[] { return [...new Set([...this.records.keys(), ...this.archived])] }

  async visible(id: string): Promise<boolean> {
    const live = this.ctx.sessions.get(id as SessionId)
    const header = live?.header ?? this.records.get(id)?.header
    if (!header || header.origin === 'subagent' || this.archived.has(id)) return false
    let hasTurn = this.turns.get(id)
    if (hasTurn === undefined) {
      const events = live?.snapshotEvents() ?? (await this.ctx.sessionQuery.readSession(id as SessionId)).events
      hasTurn = events.some(e => e.type === 'turn/start')
      this.turns.set(id, hasTurn)
    }
    return sessionVisible({ id, ...(header.origin ? { origin: header.origin } : {}), blank: !hasTurn }, this.archived, this.presence.selected())
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
