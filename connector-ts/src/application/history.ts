import { ORDER_ANCHOR_INDEX, ORDER_SUB_SLOTS, summarize, type JsonObject, type Session, type SummaryFacts, type TimelineDraft } from '../domain/conversation/index.js'
import type {
  ChangeFeed,
  Clock,
  ConversationStore,
  HistoryWindow,
  NativeHistoryPage,
  NativeSessionRef,
  NativeSessionSummary,
  RuntimeHandle,
  RuntimeHandles,
  SessionCommit,
  TimelineChange,
} from './ports/index.js'
import { TimelineProjector } from './projection.js'

/** Error codes a Runtime uses when a history cursor no longer matches the native record (rewritten history). */
export const HISTORY_CURSOR_INVALID = new Set(['history_cursor_invalid', 'history_reset'])

/** Projection bookkeeping per Conversation, in `runtime_kv` under the Runtime's id. */
interface HistoryState {
  /** Cursor for the page before the oldest projected one; null when the beginning is projected. */
  olderCursor: string | null
  /** Cursor for content after the newest projected page. */
  newerCursor: string | null
  /** The native session's `updatedAt` when it was last projected. */
  nativeUpdatedAt: string | null
}

export interface NativeHistoryDeps {
  readonly store: ConversationStore
  readonly feed: ChangeFeed
  readonly runtimes: RuntimeHandles
  readonly clock: Clock
  /** Items per projected page (04-connector.md §6.6: about one snapshot page). */
  readonly pageLimit?: number
  /** The Conversation id of a discovered native session (v2 identity rules per Runtime type). */
  readonly sessionIdFor: (handle: RuntimeHandle, runtimeId: string, ref: NativeSessionSummary) => string
  /** Sessions with an open Runtime session get new content from live events, not from the native record. */
  readonly isBound?: (sessionId: string) => boolean
  readonly onError?: (sessionId: string | null, error: unknown) => void
}

const stateKey = (sessionId: string): string => `history:${sessionId}`
/** The permission the Runtime reported for a native session not open here (`NativeSessionSummary.permission`). */
const permissionKey = (sessionId: string): string => `native-permission:${sessionId}`
/** Native user message item id -> the stored user item it is (`NativeHistory.sameUserMessages`). */
const aliasKey = (sessionId: string): string => `history-aliases:${sessionId}`
const piReplayRepairKey = (sessionId: string): string => `pi-assistant-replay-repaired:${sessionId}`
/** How many of the newest stored items are searched for the user message a native one repeats. */
const USER_MATCH_WINDOW = 500

interface HistorySource {
  session: Session
  handle: RuntimeHandle
  ref: NativeSessionRef
}

function text(content: JsonObject): string {
  return typeof content.text === 'string' ? content.text.trim() : ''
}

function isUserMessage(item: TimelineDraft): boolean {
  return item.type === 'message' && item.role === 'user'
}

/**
 * When native history is projected into the local store (04-connector.md §6.6):
 * - on discovery, only the latest page (summary, `latestTurnEndSeq` and unread need no more);
 * - earlier pages when a client pages back past what is stored (`store.read before`);
 * - later content incrementally from the Runtime's cursor; a rewritten record is projected again from the
 *   latest page and raises the reset fence.
 *
 * Runtimes do not give a native position yet, so pages are placed relative to what is stored: older pages
 * below the oldest item, newer content above the newest, the first page just below the anchor that live items
 * count up from. Items already stored keep their `orderSeq`.
 */
export class NativeHistory {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly pageLimit: number

  public constructor(private readonly deps: NativeHistoryDeps) {
    this.pageLimit = deps.pageLimit ?? 100
  }

  private serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(work, work)
    const tail = next.catch(() => undefined)
    this.chains.set(sessionId, tail)
    void tail.then(() => {
      if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId)
    })
    return next
  }

  private async state(session: Session): Promise<HistoryState | null> {
    const value = await this.deps.store.kv.get(session.runtimeId, stateKey(session.sessionId))
    return value === null || value === undefined ? null : (value as HistoryState)
  }

  private async saveState(session: Session, state: HistoryState): Promise<void> {
    await this.deps.store.kv.set(session.runtimeId, stateKey(session.sessionId), state)
  }

  /**
   * Selections as the Runtime last reported them for a session that is not open here: today the permission of an
   * unopened Codex thread (`{permission: <selection id>}`). Null when nothing was reported (no default is assumed)
   * or the session is open, where its own configuration is what counts.
   */
  public async nativeSelections(sessionId: string): Promise<Record<string, string> | null> {
    if (this.deps.isBound?.(sessionId) === true) return null
    const session = await this.deps.store.sessions.get(sessionId)
    if (session === null) return null
    const stored = await this.deps.store.kv.get(session.runtimeId, permissionKey(sessionId))
    const permission = (stored as { permission?: unknown } | null | undefined)?.permission
    return typeof permission === 'string' && permission !== '' ? { permission } : null
  }

  /** Keeps the last reported permission; a summary without one forgets it rather than keeping a stale value. */
  private async rememberPermission(session: Session, permission: string | undefined): Promise<void> {
    const key = permissionKey(session.sessionId)
    const stored = (await this.deps.store.kv.get(session.runtimeId, key)) as { permission?: unknown } | null | undefined
    if (permission === undefined || permission === '') {
      if (stored !== null && stored !== undefined) await this.deps.store.kv.delete(session.runtimeId, key)
      return
    }
    if (stored?.permission !== permission) await this.deps.store.kv.set(session.runtimeId, key, { permission })
  }

  private async source(sessionId: string): Promise<HistorySource | null> {
    const session = await this.deps.store.sessions.get(sessionId)
    if (session === null || session.externalSessionId === null) return null
    const handle = await this.deps.runtimes.handle(session.runtimeId)
    if (handle === null) return null
    return { session, handle, ref: { nativeSessionId: session.externalSessionId, ...(session.cwd ? { cwd: session.cwd } : {}) } }
  }

  private read(source: HistorySource, window: HistoryWindow): Promise<NativeHistoryPage> {
    return source.handle.readNativeHistory(source.ref, { ...window, sessionId: source.session.sessionId })
  }

  /** Projects the latest page once (discovery, or before a Runtime session is opened). */
  public ensureLatest(sessionId: string): Promise<void> {
    return this.serial(sessionId, async () => {
      const source = await this.source(sessionId)
      if (source === null) return
      if ((await this.state(source.session)) === null) await this.projectLatest(source, null, false)
      else if (source.session.runtimeType === 'pi') {
        await this.repairPiReplies(source).catch(error => this.deps.onError?.(sessionId, error))
      }
    })
  }

  /** Older versions could persist both IDs. Keep the original live reply and its order. */
  private async repairPiReplies(source: HistorySource): Promise<void> {
    const { sessionId, runtimeId } = source.session
    const { kv, timeline } = this.deps.store
    const key = piReplayRepairKey(sessionId)
    if (await kv.get(runtimeId, key) === true) return
    const { itemAliases } = await this.read(source, { limit: 1, reconcile: true })
    if (itemAliases === undefined) return
    const deletes: string[] = []
    let pending = false
    for (const [currentId, previousIds] of itemAliases) {
      const current = await timeline.get(sessionId, currentId)
      if (current === null) continue
      for (const id of previousIds) {
        if (await timeline.get(sessionId, id) === null) continue
        // A streamed reply can still be incomplete. Revisit it after it settles.
        if (current.status === 'running' || current.status === 'pending') pending = true
        else deletes.push(id)
      }
    }
    if (deletes.length > 0) await this.apply(sessionId, { upserts: [], deletes, at: this.deps.clock.nowIso() })
    if (!pending) await kv.set(runtimeId, key, true)
  }

  /** Whether the native record has items older than the projected ones. */
  public async hasOlder(sessionId: string): Promise<boolean> {
    const session = await this.deps.store.sessions.get(sessionId)
    if (session === null) return false
    return ((await this.state(session))?.olderCursor ?? null) !== null
  }

  /**
   * Projects older pages until `limit` items are stored before `beforeOrderSeq` (null: before everything) or the
   * native record has no more. Returns whether anything was added.
   */
  public ensureBefore(sessionId: string, beforeOrderSeq: number | null, limit: number): Promise<boolean> {
    return this.serial(sessionId, async () => {
      const source = await this.source(sessionId)
      if (source === null) return false
      let state = await this.state(source.session)
      if (state === null) {
        await this.projectLatest(source, null, false)
        state = await this.state(source.session)
      }
      let added = false
      for (;;) {
        if (state === null || state.olderCursor === null) return added
        const stored = await this.deps.store.timeline.read(sessionId, beforeOrderSeq === null ? 'latest' : 'before', beforeOrderSeq, limit, Number.MAX_SAFE_INTEGER)
        if (stored.items.length >= limit) return added
        const page = await this.read(source, { cursor: state.olderCursor, limit: this.pageLimit, direction: 'older' })
        const commit = await this.place(source.session, page, 'below', {})
        added ||= commit !== null && commit.changed.length > 0
        state = { ...state, olderCursor: page.olderCursor ?? null }
        await this.saveState(source.session, state)
        if (page.items.length === 0) return added
      }
    })
  }

  /** Projects content the native record gained since the last projection (sessions without a live binding). */
  public catchUp(sessionId: string, nativeUpdatedAt: string | null = null): Promise<void> {
    return this.serial(sessionId, async () => {
      if (this.deps.isBound?.(sessionId) === true) return
      const source = await this.source(sessionId)
      if (source === null) return
      const state = await this.state(source.session)
      if (state === null || state.newerCursor === null) {
        // No cursor: read the latest page again; items not stored yet are newer than everything stored.
        await this.projectLatest(source, nativeUpdatedAt, false, state === null ? 'below' : 'above', state)
        return
      }
      let cursor = state.newerCursor
      for (;;) {
        let page
        try {
          page = await this.read(source, { cursor, limit: this.pageLimit, direction: 'newer' })
        } catch (error) {
          if (!HISTORY_CURSOR_INVALID.has((error as { code?: string }).code ?? '')) throw error
          // The native record was rewritten: project it again and make clients take a snapshot.
          await this.projectLatest(source, nativeUpdatedAt, true)
          return
        }
        if (page.items.length > 0) await this.place(source.session, page, 'above', { turnEnded: source.session.activeTurn === null })
        const next = page.newerCursor ?? cursor
        await this.saveState(source.session, { ...state, newerCursor: next, nativeUpdatedAt: nativeUpdatedAt ?? state.nativeUpdatedAt })
        if (page.items.length < this.pageLimit || next === cursor) return
        cursor = next
      }
    })
  }

  private async projectLatest(
    source: HistorySource,
    nativeUpdatedAt: string | null,
    replace: boolean,
    where: 'below' | 'above' = 'below',
    previous: HistoryState | null = null,
  ): Promise<void> {
    const page = await this.read(source, { limit: this.pageLimit })
    await this.place(source.session, page, replace ? 'replace' : where, { turnEnded: page.items.length > 0 && source.session.activeTurn === null })
    // A repeated latest read keeps the older cursor of the first one: pages below are unchanged.
    const olderCursor = previous !== null && !replace ? previous.olderCursor : page.olderCursor ?? null
    await this.saveState(source.session, { olderCursor, newerCursor: page.newerCursor ?? null, nativeUpdatedAt })
  }

  /** Projects a history page (oldest first) and positions new items relative to the stored timeline. */
  private async place(session: Session, { items: events, itemAliases }: NativeHistoryPage, where: 'below' | 'above' | 'replace', patch: { turnEnded?: boolean }): Promise<SessionCommit | null> {
    if (events.length === 0 && where !== 'replace') return null
    const projector = new TimelineProjector(session.runtimeType, session.externalSessionId, null, () => this.deps.clock.nowIso())
    const drafts = new Map<string, TimelineDraft>()
    for (const event of events) {
      const draft = projector.apply(event)
      drafts.set(draft.id, draft)
    }
    const ordered = [...drafts.values()].sort((a, b) => a.orderSeq - b.orderSeq)
    const fresh: TimelineDraft[] = []
    const upserts: TimelineDraft[] = []
    const deletes: string[] = []
    const same = where === 'replace' ? null : await this.sameUserMessages(session, ordered)
    for (const draft of ordered) {
      // A user message this device already stored (sent from here, under its own id) stays as it was stored.
      if (same?.has(draft.id) === true) continue
      const stored = where === 'replace' ? null : await this.deps.store.timeline.get(session.sessionId, draft.id)
      const aliases = where === 'replace' ? undefined : itemAliases?.get(draft.id)
      if (aliases) {
        deletes.push(...aliases)
        // A live reply already represents this native message. Keep its original metadata and position.
        if (stored !== null && stored.status === draft.status && stored.content.text === draft.content.text) continue
      }
      let orderSeq = stored?.orderSeq
      if (orderSeq === undefined && aliases) {
        for (const id of aliases) {
          const old = await this.deps.store.timeline.get(session.sessionId, id)
          if (old !== null) orderSeq = Math.min(orderSeq ?? old.orderSeq, old.orderSeq)
        }
      }
      if (orderSeq !== undefined) upserts.push({ ...draft, orderSeq })
      else fresh.push(draft)
    }
    // Positions in first-appearance order: the projector numbered drafts from the anchor, one native index each.
    const indexOf = (draft: TimelineDraft): number => Math.floor(draft.orderSeq / ORDER_SUB_SLOTS) - ORDER_ANCHOR_INDEX
    const subOf = (draft: TimelineDraft): number => draft.orderSeq % ORDER_SUB_SLOTS
    const span = fresh.length === 0 ? 0 : indexOf(fresh[fresh.length - 1]!) - indexOf(fresh[0]!) + 1
    let base: number
    if (where === 'above') {
      const newest = await this.deps.store.timeline.latest(session.sessionId)
      base = newest === null ? ORDER_ANCHOR_INDEX : Math.floor(newest.orderSeq / ORDER_SUB_SLOTS) + 1
    } else if (where === 'replace') {
      base = ORDER_ANCHOR_INDEX - span
    } else {
      const oldest = (await this.deps.store.timeline.read(session.sessionId, 'after', null, 1, Number.MAX_SAFE_INTEGER)).items[0]
      base = (oldest === undefined ? ORDER_ANCHOR_INDEX : Math.floor(oldest.orderSeq / ORDER_SUB_SLOTS)) - span
    }
    const first = fresh[0] === undefined ? 0 : indexOf(fresh[0])
    for (const draft of fresh) {
      const index = base + indexOf(draft) - first
      if (index < 1) continue // Out of room below: older items stay unprojected.
      upserts.push({ ...draft, orderSeq: index * ORDER_SUB_SLOTS + subOf(draft) })
    }
    if (upserts.length === 0 && deletes.length === 0 && where !== 'replace') return null
    return this.apply(session.sessionId, {
      upserts,
      ...(deletes.length > 0 ? { deletes } : {}),
      ...(where === 'replace' ? { replace: {} } : {}),
      ...(patch.turnEnded === true ? { session: { turnEnded: true } } : {}),
      at: this.deps.clock.nowIso(),
    })
  }

  private async apply(sessionId: string, change: TimelineChange): Promise<SessionCommit> {
    const commit = await this.deps.store.timeline.apply(sessionId, change)
    if (commit.toSeq >= commit.fromSeq && (commit.changed.length > 0 || commit.deleted.length > 0 || commit.reset)) {
      this.deps.feed.publish({ sessionId, fromSeq: commit.fromSeq, toSeq: commit.toSeq, resetSeq: commit.session.clock.resetSeq, reset: commit.reset })
    }
    return commit
  }

  /**
   * The native user messages in `drafts` that repeat a user message this device stored itself. A message sent from
   * this device is stored under the id the Runtime gave it when it was sent; the native record names the same
   * message differently (Pi by its entry, Claude by its JSONL uuid), so it is matched by the client message id when
   * the record carries it (Pi), else by its text against a stored message sent from here that no native message
   * matched yet. Matches are kept, so a message is matched once however often its page is projected.
   */
  private async sameUserMessages(session: Session, drafts: readonly TimelineDraft[]): Promise<Set<string>> {
    const same = new Set<string>()
    const timeline = this.deps.store.timeline
    const stored = (await this.deps.store.kv.get(session.runtimeId, aliasKey(session.sessionId))) as Record<string, string> | null | undefined
    const aliases: Record<string, string> = { ...(stored ?? {}) }
    let changed = false
    let candidates: TimelineDraft[] | null = null
    for (const draft of drafts) {
      if (!isUserMessage(draft)) continue
      if (aliases[draft.id] !== undefined) {
        same.add(draft.id)
        continue
      }
      if ((await timeline.get(session.sessionId, draft.id)) !== null) continue
      const clientMessageId = typeof draft.content.clientMessageId === 'string' ? draft.content.clientMessageId : null
      let match: string | null = null
      if (clientMessageId !== null) {
        const item = await timeline.findByClientMessageId(session.sessionId, clientMessageId)
        if (item !== null && item.id !== draft.id && isUserMessage(item)) match = item.id
      } else if (text(draft.content) !== '') {
        if (candidates === null) {
          const claimed = new Set(Object.values(aliases))
          const page = await timeline.read(session.sessionId, 'latest', null, USER_MATCH_WINDOW, Number.MAX_SAFE_INTEGER)
          candidates = page.items
            .filter(item => isUserMessage(item) && item.status !== 'failed' && typeof item.content.clientMessageId === 'string' && !claimed.has(item.id))
            .sort((a, b) => a.orderSeq - b.orderSeq)
        }
        const index = candidates.findIndex(item => text(item.content) === text(draft.content))
        if (index >= 0) match = candidates.splice(index, 1)[0]!.id
      }
      if (match === null) continue
      aliases[draft.id] = match
      same.add(draft.id)
      changed = true
    }
    if (changed) await this.deps.store.kv.set(session.runtimeId, aliasKey(session.sessionId), aliases)
    return same
  }

  /**
   * Native session discovery for one Runtime: a Conversation per native session (metadata only), the latest page
   * projected for new or changed ones, and `session.inventory` in the outbox (100 sessions per record; the
   * last one says whether the scan was complete).
   */
  public async scan(runtimeId: string, scanId: string): Promise<{ sessions: number; complete: boolean }> {
    const handle = await this.deps.runtimes.handle(runtimeId)
    if (handle === null) return { sessions: 0, complete: false }
    // DSH generates its own IDs and skips open sessions in session/list. Reuse the Conversation already bound
    // to a native ID, even across Connector restarts, and keep bound sessions in a complete inventory.
    const dshSessions = handle.type === 'dsh'
      ? (await this.deps.store.sessions.list()).filter(session => session.runtimeType === 'dsh' && session.externalSessionId !== null)
      : []
    const knownDshSessions = dshSessions.filter(session => session.runtimeId === runtimeId)
    const dshIds = new Map(knownDshSessions.map(session => [session.externalSessionId, session.sessionId]))
    const otherDshIds = new Set(dshSessions.filter(session => session.runtimeId !== runtimeId).map(session => session.externalSessionId))
    const facts: SummaryFacts[] = []
    let complete = true
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      let page
      try {
        page = await handle.listNativeSessions(cursor)
      } catch (error) {
        this.deps.onError?.(null, error)
        complete = false
        break
      }
      if (page.complete === false) complete = false
      for (const summary of page.sessions) {
        try {
          const knownSessionId = dshIds.get(summary.nativeSessionId)
          // The implicit legacy instance can share the named instance's DSH home.
          if (knownSessionId === undefined && otherDshIds.has(summary.nativeSessionId)) continue
          const session = await this.discover(handle, runtimeId, summary, knownSessionId)
          if (seen.has(session.sessionId)) continue
          seen.add(session.sessionId)
          facts.push(summarize(session, await this.deps.store.timeline.latest(session.sessionId)))
        } catch (error) {
          this.deps.onError?.(null, error)
          complete = false
        }
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    for (const session of knownDshSessions) {
      if (!seen.has(session.sessionId) && this.deps.isBound?.(session.sessionId) === true) {
        facts.push(summarize(session, await this.deps.store.timeline.latest(session.sessionId)))
      }
    }
    const at = this.deps.clock.nowIso()
    for (let start = 0; start < facts.length || start === 0; start += 100) {
      const batch = facts.slice(start, start + 100)
      const last = start + 100 >= facts.length
      await this.deps.store.outbox.append('session.inventory', null, { runtimeId, scanId, complete: last && complete, sessions: batch }, at)
      if (last) break
    }
    return { sessions: facts.length, complete }
  }

  private async discover(handle: RuntimeHandle, runtimeId: string, summary: NativeSessionSummary, knownSessionId?: string): Promise<Session> {
    const sessionId = knownSessionId ?? this.deps.sessionIdFor(handle, runtimeId, summary)
    const availability = summary.archived === true ? 'archived' : 'available'
    const at = this.deps.clock.nowIso()
    let { session } = await this.deps.store.sessions.create({
      sessionId,
      runtimeType: handle.type,
      runtimeId,
      externalSessionId: summary.nativeSessionId,
      cwd: summary.cwd ?? null,
      nativeTitle: summary.title ?? null,
      status: 'idle',
      sourceAvailability: availability,
      takeover: false,
      at: summary.createdAt ?? at,
    })
    const patch: Parameters<ConversationStore['sessions']['update']>[1] = {}
    if (summary.title !== undefined && summary.title !== session.nativeTitle) patch.nativeTitle = summary.title
    if (summary.cwd !== undefined && summary.cwd !== session.cwd) patch.cwd = summary.cwd
    if (session.sourceAvailability !== availability) patch.sourceAvailability = availability
    if (Object.keys(patch).length > 0) session = (await this.deps.store.sessions.update(sessionId, patch)).session
    await this.rememberPermission(session, summary.permission)
    const state = await this.state(session)
    if (state === null || (summary.updatedAt !== undefined && summary.updatedAt !== state.nativeUpdatedAt)) {
      if (this.deps.isBound?.(sessionId) !== true) await this.catchUp(sessionId, summary.updatedAt ?? null)
      session = (await this.deps.store.sessions.get(sessionId)) ?? session
    }
    return session
  }
}
