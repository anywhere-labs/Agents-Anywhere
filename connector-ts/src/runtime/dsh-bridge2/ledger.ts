/**
 * `Bridge2Ledger` on the v3 local store (A's `ConversationStore`, #670/#674). A 2.0 plugin
 * sends platform-shaped notifications; this writes them where the session engine would have:
 * timeline items and session facts into the store (each commit announced on the ChangeFeed),
 * lossy live facts (notices, capabilities, catalogs) through `live`, checkpoints into the
 * runtime KV. A resolved call means "committed locally" (04-connector.md §5.6).
 *
 * Atomicity: the store commits per session, so a batch spanning sessions is applied in order,
 * one commit at a time. A batch that fails half-way is resent whole; every write here is an
 * idempotent upsert, so the resend converges.
 */
import type { ChangeFeed, ConversationStore, SessionCommit, SessionPatch } from '../../application/ports/index.js'
import { TIMELINE_ITEM_TYPES, type JsonObject, type SessionStatus, type SourceAvailability, type TimelineDraft,
  type TimelineItemStatus, type TimelineItemType, type TimelineRole, type TimelineSource } from '../../domain/conversation/index.js'
import { BACKEND_UNAVAILABLE, Bridge2Error, type Bridge2Ledger, type Json, type Notification } from './relay.js'

const SESSION_STATUSES: ReadonlySet<string> = new Set<SessionStatus>(['idle', 'pending', 'running', 'waiting', 'waiting_approval', 'blocked', 'stopping', 'error', 'unknown'])
const AVAILABILITY: Readonly<Record<string, SourceAvailability>> = {
  available: 'available', archived: 'archived', deleted: 'deleted', missing: 'missing', unavailable: 'missing',
}
/** v2 Server event names for the facts that are not timeline content. */
const LIVE_METHODS: Readonly<Record<string, string>> = {
  'notice.upsert': 'runtime.notice.updated',
  'runtime.capability.updated': 'runtime.capability.updated',
  'session.capability.updated': 'runtime.capability.updated',
  'catalog.model.update': 'runtime.catalog.updated',
  'catalog.permission.update': 'runtime.catalog.updated',
}

/** A 2.0 timeline item (contracts/dsh-bridge/1.0 timeline-item) as a v3 draft; `null` means "hide it". */
export function draftOf(raw: Json, now: string): TimelineDraft | null {
  if (raw.status === 'hidden') return null
  const id = raw.id
  if (typeof id !== 'string' || !id) throw new Error('Invalid DSH timeline item')
  const rawType = String(raw.type)
  // 2.0 turn boundaries are markers in v3; the kind stays in the content (`turn_start` / `turn_end`).
  const type = (rawType === 'turn.start' || rawType === 'turn.end' ? 'marker' : rawType) as TimelineItemType
  if (!TIMELINE_ITEM_TYPES.has(type)) throw new Error(`Unsupported DSH timeline item type ${rawType}`)
  const status = (raw.status === 'inProgress' ? 'running' : raw.status) as TimelineItemStatus
  const source = (typeof raw.source === 'object' && raw.source !== null ? raw.source : {}) as Json
  const content = (typeof raw.content === 'object' && raw.content !== null ? raw.content : {}) as JsonObject
  const time = typeof source.time === 'number' && source.time > 0 ? new Date(source.time).toISOString() : undefined
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : time ?? now
  return {
    id, type, status,
    role: (raw.role ?? null) as TimelineRole | null,
    orderSeq: typeof raw.orderSeq === 'number' ? raw.orderSeq : 0,
    content,
    source: { ...source, runtime: typeof source.runtime === 'string' && source.runtime ? source.runtime : 'dsh' } as TimelineSource,
    createdAt,
    ...(typeof raw.completedAt === 'string' ? { completedAt: raw.completedAt } : {}),
  }
}

function text(value: unknown): string | null { return typeof value === 'string' && value ? value : null }

/**
 * Where the ledger's live facts go: v2 event names with the 2.0 plugin's own payloads. They are not the
 * device-meshcall 1.0 `Link/attach` shapes (`LiveEvents`): `runtime.status` carries no `runtimeId` and no `status`
 * object, and `runtime.capability.updated` / `runtime.catalog.updated` are not attach events.
 */
export interface Bridge2LiveSink {
  emit(method: string, payload: Record<string, unknown>): void
}

export interface StoreLedgerDeps {
  readonly store: ConversationStore
  readonly feed: ChangeFeed
  readonly live: Bridge2LiveSink
  /** The DSH runtime instance these sessions belong to. */
  readonly runtimeId: string
  readonly now?: () => string
  /** `planning.observed` facts for the Planning application; dropped when absent. */
  readonly planning?: (params: Json) => Promise<void>
  /** `session.inventory.begin/complete` (baseline progress); ignored when absent. */
  readonly inventory?: (method: string, params: Json) => void
}

export class StoreBridge2Ledger implements Bridge2Ledger {
  private readonly now: () => string

  constructor(private readonly deps: StoreLedgerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  async publish(notifications: readonly Notification[]): Promise<void> {
    await this.guard(async () => { for (const notice of notifications) await this.apply(notice) })
  }

  async replaceSession(sessionId: string, meta: Json, items: readonly Json[]): Promise<void> {
    await this.guard(async () => {
      const at = this.now()
      await this.ensureSession(sessionId, meta)
      const upserts = items.map(item => draftOf(item, at)).filter((draft): draft is TimelineDraft => draft !== null)
      this.announce(await this.deps.store.timeline.apply(sessionId, { upserts, replace: {}, session: this.metaPatch(meta), at }))
    })
  }

  readState(key: string): Promise<unknown> { return this.guard(() => this.deps.store.kv.get(this.deps.runtimeId, key)) }
  writeState(key: string, value: Json): Promise<void> { return this.guard(() => this.deps.store.kv.set(this.deps.runtimeId, key, value)) }
  deleteState(key: string): Promise<void> { return this.guard(() => this.deps.store.kv.delete(this.deps.runtimeId, key)) }

  /** A store that cannot write right now (read-only, worker gone) is retryable for the plugin. */
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'store_read_only' || (error as Error).message === 'store closed') throw new Bridge2Error(BACKEND_UNAVAILABLE, String((error as Error).message), true)
      throw error
    }
  }

  private async apply(notice: Notification): Promise<void> {
    const { method, params } = notice
    const sessionId = text(params.sessionId)
    switch (method) {
      case 'timeline.itemUpsert': {
        await this.ensureSession(sessionId!, params)
        const at = this.now()
        const draft = draftOf(params.item as Json, at)
        const change = draft ? { upserts: [draft], at } : { upserts: [], deletes: [String((params.item as Json).id)], at }
        this.announce(await this.deps.store.timeline.apply(sessionId!, change))
        return
      }
      case 'session.meta.upsert':
        await this.ensureSession(sessionId!, params)
        this.announce(await this.deps.store.sessions.update(sessionId!, this.metaPatch(params)))
        return
      case 'session.state.updated': {
        await this.ensureSession(sessionId!, params)
        const status = SESSION_STATUSES.has(String(params.status)) ? params.status as SessionStatus : 'unknown'
        this.announce(await this.deps.store.sessions.update(sessionId!, { status }))
        this.deps.live.emit('runtime.status', { sessionId, event: 'session.state', ...params })
        return
      }
      case 'session.source.updated':
        await this.ensureSession(sessionId!, params)
        this.announce(await this.deps.store.sessions.update(sessionId!, { sourceAvailability: AVAILABILITY[String(params.availability)] ?? 'unknown' }))
        return
      case 'session.turnEnded':
        await this.ensureSession(sessionId!, params)
        this.announce(await this.deps.store.sessions.update(sessionId!, { turnEnded: true }))
        return
      case 'planning.observed':
        await this.deps.planning?.(params)
        return
      case 'session.inventory.begin':
      case 'session.inventory.complete':
        this.deps.inventory?.(method, params)
        return
      default: {
        const live = LIVE_METHODS[method]
        if (!live) throw new Error(`Unsupported runtime notification: ${method}`)
        this.deps.live.emit(live, method === 'notice.upsert' ? { sessionId, notice: params } : { source: method, ...params })
      }
    }
  }

  private metaPatch(meta: Json): SessionPatch {
    const patch: SessionPatch = {}
    if (text(meta.externalSessionId)) patch.externalSessionId = text(meta.externalSessionId)
    if (text(meta.cwd)) patch.cwd = text(meta.cwd)
    if ('title' in meta) patch.nativeTitle = text(meta.title)
    const ordering = text(meta.orderingTime) ?? text(meta.lastActivityAt)
    if (ordering) patch.lastActivityAt = ordering
    const source = meta.sourceState as Json | undefined
    if (source && typeof source.availability === 'string') patch.sourceAvailability = AVAILABILITY[source.availability] ?? 'unknown'
    return patch
  }

  /** Sessions the plugin discovered are created on first sight, as the session engine does for native sessions. */
  private async ensureSession(sessionId: string, facts: Json): Promise<void> {
    if (!sessionId) throw new Error('A DSH notification without a session')
    if (await this.deps.store.sessions.get(sessionId)) return
    await this.deps.store.sessions.create({
      sessionId, runtimeType: 'dsh', runtimeId: this.deps.runtimeId,
      externalSessionId: text(facts.externalSessionId), cwd: text(facts.cwd), nativeTitle: text(facts.title),
      status: 'idle', sourceAvailability: 'available', takeover: false, at: this.now(),
    })
  }

  private announce(commit: SessionCommit): void {
    if (commit.toSeq >= commit.fromSeq && (commit.changed.length > 0 || commit.deleted.length > 0 || commit.reset)) {
      this.deps.feed.publish({ sessionId: commit.session.sessionId, fromSeq: commit.fromSeq, toSeq: commit.toSeq,
        resetSeq: commit.session.clock.resetSeq, reset: commit.reset })
    }
    if (commit.summary !== null) this.deps.live.emit('runtime.status', { sessionId: commit.session.sessionId, event: 'session.status', status: commit.session.status })
  }
}
