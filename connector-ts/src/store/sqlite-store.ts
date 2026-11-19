import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

import type { AgentAction, AgentGrant, Supervision } from '../domain/collab/index.js'
import type { MessageAuthor, SessionOrigin } from '../domain/conversation/index.js'
import type {
  BlobRecord,
  BlobRepository,
  CollabRepository,
  SpawnedChild,
  ChangesPage,
  CommandLog,
  CommandReceipt,
  CommandRecord,
  ConversationStore,
  DeliveryRepository,
  GoalRepository,
  InteractionRepository,
  NewSession,
  OutboxRecord,
  OutboxStore,
  PendingDelivery,
  PreparationRepository,
  PlanningRepository,
  QueueOp,
  QueueRepository,
  ReadMode,
  ReceiveMessageInput,
  ReceiveMessageResult,
  RuntimeKv,
  SessionCommit,
  SessionPatch,
  SessionRepository,
  TimelineChange,
  TimelinePage,
  TimelineRepository,
} from '../application/ports/index.js'
import {
  ConversationError,
  allocate,
  applySeqFloor,
  catchUp,
  decideUpsert,
  delivery as deliveryRules,
  interaction as interactionRules,
  queue as queueRules,
  raiseResetFence,
  summarize,
  summaryChanged,
  type ActiveTurn,
  type Delivery,
  type DeliveryState,
  type Interaction,
  type QueueItem,
  type Session,
  type SessionClock,
  type SessionQueue,
  type SummaryFacts,
  type TimelineDraft,
  type TimelineItem,
} from '../domain/conversation/index.js'
import type { Preparation } from '../domain/creation/index.js'
import { goalStateSummary, type GoalState } from '../domain/goals/index.js'
import { planStateSummary, type PlanDocument, type PlanningState } from '../domain/planning/index.js'
import { BlobFiles } from './blob-files.js'
import { SCHEMA_VERSION, migrate, schemaVersion } from './schema.js'
import { PAGE_BUDGET, PAGE_LIMIT_MAX } from '../domain/conversation/index.js'
import { fitPage, jsonBytes, slimDraft } from './slim.js'

/** The synchronous form of a repository port: what runs on the store thread. */
export type Sync<T> = { [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : T[K] }

export type SyncStore = { [K in Exclude<keyof ConversationStore, 'close'>]: Sync<ConversationStore[K]> } & { close(): void; readonly readOnly: boolean; readonly storeEpoch: string }

export class StoreError extends Error {
  public constructor(
    /** `store_unavailable`: the store worker exited or crashed; nothing can be read or written until a restart. */
    public readonly code: 'store_read_only' | 'store_corrupt' | 'not_found' | 'store_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'StoreError'
  }
}

export interface OpenStoreOptions {
  /** `~/.agents-anywhere/v3` or `AGENT_CONNECTOR_DATA_DIR` (resolved by the host). */
  readonly dataDir: string
  /**
   * `full` adds `fullfsync` on macOS, where a plain fsync does not flush the disk cache (S3: ~4 ms per commit
   * instead of ~0.04 ms). Default `full`: commands are acknowledged only after their commit is durable.
   */
  readonly durability?: 'full' | 'normal'
  readonly now?: () => string
}

type Row = Record<string, SQLInputValue>

const STATUS_DEFAULT_LIMIT = 100
/** Blob files younger than this are never swept (see `sweepBlobs`). */
const BLOB_SWEEP_MIN_AGE_MS = 60 * 60 * 1000

function json(value: unknown): string {
  return JSON.stringify(value)
}

function parse<T>(text: unknown): T {
  return JSON.parse(String(text)) as T
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

/**
 * The SQLite store (04-connector.md §6). WAL, `synchronous=FULL`; all access on one thread (the worker),
 * one transaction per port method.
 */
export function openSqliteStore(options: OpenStoreOptions): SyncStore {
  const now = options.now ?? (() => new Date().toISOString())
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })
  const dbPath = join(options.dataDir, 'store.sqlite')
  let db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 5000')
  let readOnly = false
  const found = schemaVersion(db)
  if (found > SCHEMA_VERSION) {
    // Written by a newer Connector: read it, never write it (04-connector.md §6.5, §9.1).
    db.close()
    db = new DatabaseSync(dbPath, { readOnly: true })
    readOnly = true
  } else {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    if ((options.durability ?? 'full') === 'full' && process.platform === 'darwin') db.exec('PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON')
    // No foreign keys: no table declares one. The store keeps a session and its rows consistent itself, by writing
    // them in one transaction per port method (`requireSession` before child rows). Cascading deletes would not fit
    // either: the outbox (notices still to send), operations (receipts the Server may still retry against) and
    // seq_floors (floors of sessions not created yet) must outlive a session, and blob files and attachment folders
    // are not rows. A future session delete belongs in one store method, with a test that walks every table that has
    // a session_id column, so a new table cannot be missed.
    migrate(db, now())
  }
  const blobs = new BlobFiles(join(options.dataDir, 'blobs'))
  const statements = new Map<string, StatementSync>()
  const sql = (text: string): StatementSync => {
    let statement = statements.get(text)
    if (statement === undefined) {
      statement = db.prepare(text)
      statements.set(text, statement)
    }
    return statement
  }
  const get = (text: string, ...params: SQLInputValue[]): Row | undefined => sql(text).get(...params) as Row | undefined
  const all = (text: string, ...params: SQLInputValue[]): Row[] => sql(text).all(...params) as Row[]
  const run = (text: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } => sql(text).run(...params)

  let storeEpoch = nullableString(get("SELECT value FROM meta WHERE key = 'store_epoch'")?.value)
  if (storeEpoch === null) {
    storeEpoch = randomUUID()
    if (!readOnly) run("INSERT INTO meta(key, value) VALUES ('store_epoch', ?)", storeEpoch)
  }

  let depth = 0
  /** File deletions that must wait until the transaction that dropped the last reference has committed. */
  let afterCommit: Array<() => void> = []
  function tx<T>(work: () => T): T {
    if (readOnly) throw new StoreError('store_read_only', 'the local store was written by a newer Connector and is read-only')
    if (depth > 0) {
      depth++
      try {
        return work()
      } finally {
        depth--
      }
    }
    db.exec('BEGIN IMMEDIATE')
    depth = 1
    afterCommit = []
    try {
      const result = work()
      db.exec('COMMIT')
      const pending = afterCommit
      afterCommit = []
      for (const task of pending) {
        try {
          task()
        } catch {
          // A file left behind is removed by the next sweep.
        }
      }
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      afterCommit = []
      throw error
    } finally {
      depth = 0
    }
  }

  // ---------------------------------------------------------------- rows

  function sessionFromRow(row: Row): Session {
    return {
      sessionId: String(row.session_id),
      runtimeType: String(row.runtime_type),
      runtimeId: String(row.runtime_id),
      externalSessionId: nullableString(row.external_session_id),
      cwd: nullableString(row.cwd),
      projectId: nullableString(row.project_id),
      origin: row.origin_json === null || row.origin_json === undefined ? null : parse<SessionOrigin>(row.origin_json),
      nativeTitle: nullableString(row.native_title),
      status: String(row.status) as Session['status'],
      sourceAvailability: String(row.source_availability) as Session['sourceAvailability'],
      clock: { headSeq: Number(row.head_seq), resetSeq: Number(row.reset_seq) },
      activeTurn: row.active_turn_json === null ? null : parse<ActiveTurn>(row.active_turn_json),
      latestTurnEndSeq: nullableNumber(row.latest_turn_end_seq),
      planState: String(row.plan_state) as Session['planState'],
      goalState: String(row.goal_state) as Session['goalState'],
      takeover: Number(row.takeover) === 1,
      archived: Number(row.archived) === 1,
      createdAt: String(row.created_at),
      lastActivityAt: String(row.last_activity_at),
    }
  }

  function itemFromRow(row: Row): TimelineItem {
    return parse<TimelineItem>(row.payload_json)
  }

  function deliveryFromRow(row: Row): Delivery {
    return {
      sessionId: String(row.session_id),
      clientMessageId: String(row.client_message_id),
      state: String(row.state) as DeliveryState,
      inputDigest: String(row.input_digest),
      nativeRef: nullableString(row.native_ref),
      errorCode: nullableString(row.error_code),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  function interactionFromRow(row: Row): Interaction {
    return {
      sessionId: String(row.session_id),
      noticeId: String(row.notice_id),
      kind: String(row.kind) as Interaction['kind'],
      state: String(row.state) as Interaction['state'],
      blocking: Number(row.blocking) === 1,
      payload: parse<Record<string, unknown>>(row.payload_json),
      responseId: nullableString(row.response_id),
      resolution: nullableString(row.resolution),
      openedAt: String(row.opened_at),
      resolvedAt: nullableString(row.resolved_at),
    }
  }

  function requireSession(sessionId: string): Session {
    const row = get('SELECT * FROM sessions WHERE session_id = ?', sessionId)
    if (row === undefined) throw new StoreError('not_found', `session ${sessionId} not found`)
    return sessionFromRow(row)
  }

  function writeClock(sessionId: string, clock: SessionClock): void {
    run('UPDATE sessions SET head_seq = ?, reset_seq = ? WHERE session_id = ?', clock.headSeq, clock.resetSeq, sessionId)
  }

  function putItem(item: TimelineItem): void {
    const payload = json(item)
    run(
      `INSERT INTO timeline_items(session_id, item_id, order_seq, updated_seq, revision, content_hash, type, status, role, client_message_id, item_time, payload_json, payload_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, item_id) DO UPDATE SET order_seq = excluded.order_seq, updated_seq = excluded.updated_seq, revision = excluded.revision,
         content_hash = excluded.content_hash, type = excluded.type, status = excluded.status, role = excluded.role,
         client_message_id = excluded.client_message_id, item_time = excluded.item_time, payload_json = excluded.payload_json, payload_bytes = excluded.payload_bytes`,
      item.sessionId, item.id, item.orderSeq, item.updatedSeq, item.revision, item.contentHash, item.type, item.status, item.role,
      item.source.clientMessageId ?? null, item.createdAt, payload, Buffer.byteLength(payload, 'utf8'),
    )
    run('DELETE FROM timeline_tombstones WHERE session_id = ? AND item_id = ?', item.sessionId, item.id)
    setBlobRefs(item.sessionId, item.id, (item.blobRefs ?? []).map(ref => ref.blobId))
  }

  /**
   * Points an item at exactly these blobs. A timeline blob that loses its last reference is deleted, its file
   * once the transaction has committed (content-addressed: another item with the same content keeps it).
   */
  function setBlobRefs(sessionId: string, itemId: string, blobIds: readonly string[]): void {
    const before = all('SELECT blob_id FROM blob_refs WHERE session_id = ? AND item_id = ?', sessionId, itemId).map(row => String(row.blob_id))
    const after = new Set(blobIds)
    for (const blobId of before) {
      if (after.has(blobId)) continue
      run('DELETE FROM blob_refs WHERE session_id = ? AND item_id = ? AND blob_id = ?', sessionId, itemId, blobId)
      dropIfUnreferenced(blobId)
    }
    for (const blobId of after) run('INSERT OR IGNORE INTO blob_refs(session_id, item_id, blob_id) VALUES (?, ?, ?)', sessionId, itemId, blobId)
  }

  /** Only blobs the timeline wrote; blobs put through the repository belong to whoever put them. */
  function dropIfUnreferenced(blobId: string): void {
    if (get('SELECT 1 AS hit FROM blob_refs WHERE blob_id = ? LIMIT 1', blobId) !== undefined) return
    const row = get("SELECT sha256 FROM blobs WHERE blob_id = ? AND origin = 'timeline'", blobId)
    if (row === undefined) return
    run('DELETE FROM blobs WHERE blob_id = ?', blobId)
    const sha256 = String(row.sha256)
    afterCommit.push(() => {
      // Written again meanwhile (same content in a later transaction): keep the file.
      if (get('SELECT 1 AS hit FROM blobs WHERE sha256 = ? LIMIT 1', sha256) === undefined) blobs.remove(sha256)
    })
  }

  function getItem(sessionId: string, itemId: string): TimelineItem | null {
    const row = get('SELECT payload_json FROM timeline_items WHERE session_id = ? AND item_id = ?', sessionId, itemId)
    return row === undefined ? null : itemFromRow(row)
  }

  function latestItem(sessionId: string): TimelineItem | null {
    const row = get('SELECT payload_json FROM timeline_items WHERE session_id = ? ORDER BY order_seq DESC, item_id DESC LIMIT 1', sessionId)
    return row === undefined ? null : itemFromRow(row)
  }

  function blobSink(bytes: Uint8Array, mediaType: string | null): { blobId: string; bytes: number } {
    const record = putBlob(bytes, mediaType, 'timeline', now())
    return { blobId: record.blobId, bytes: record.size }
  }

  function putBlob(bytes: Uint8Array, mediaType: string | null, origin: string, at: string): BlobRecord {
    const sha256 = blobs.write(bytes)
    const blobId = `blob_${sha256}`
    run('INSERT INTO blobs(blob_id, sha256, size, media_type, origin, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(blob_id) DO NOTHING', blobId, sha256, bytes.byteLength, mediaType, origin, at)
    return blobFromRow(get('SELECT * FROM blobs WHERE blob_id = ?', blobId) as Row)
  }

  function blobFromRow(row: Row): BlobRecord {
    return {
      blobId: String(row.blob_id),
      sha256: String(row.sha256),
      size: Number(row.size),
      mediaType: nullableString(row.media_type),
      origin: String(row.origin),
      createdAt: String(row.created_at),
    }
  }

  function appendOutbox(kind: string, sessionId: string | null, payload: Record<string, unknown>, at: string): number {
    const result = run('INSERT INTO outbox(kind, session_id, payload_json, created_at) VALUES (?, ?, ?, ?)', kind, sessionId, json(payload), at)
    return Number(result.lastInsertRowid)
  }

  function commandFromRow(row: Row): CommandRecord {
    return {
      commandId: String(row.operation_id),
      method: String(row.method),
      sessionId: nullableString(row.session_id),
      inputDigest: nullableString(row.input_digest),
      outcome: String(row.outcome) as CommandRecord['outcome'],
      result: row.result_json === null ? null : parse<Record<string, unknown>>(row.result_json),
      error: row.error_json === null ? null : parse<CommandRecord['error']>(row.error_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  /**
   * Writes a receipt and queues `command.result`, inside the caller's transaction. A final receipt (accepted or
   * rejected) is never replaced: the one committed with the effect stands, and its result is not queued twice.
   */
  function writeReceipt(record: CommandRecord): CommandRecord {
    const row = get('SELECT * FROM operations WHERE operation_id = ?', record.commandId)
    if (row !== undefined) {
      const existing = commandFromRow(row)
      if (existing.outcome !== 'unknown') return existing
    }
    run(
      `INSERT INTO operations(operation_id, method, session_id, input_digest, outcome, result_json, error_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO UPDATE SET outcome = excluded.outcome, result_json = excluded.result_json, error_json = excluded.error_json, updated_at = excluded.updated_at`,
      record.commandId, record.method, record.sessionId, record.inputDigest, record.outcome,
      record.result === null ? null : json(record.result), record.error === null ? null : json(record.error), record.createdAt, record.updatedAt,
    )
    if (record.outcome !== 'unknown') {
      appendOutbox('command.result', record.sessionId, {
        commandId: record.commandId,
        outcome: record.outcome,
        ...(record.result !== null ? { r: record.result } : {}),
        ...(record.error !== null ? { e: record.error } : {}),
      }, record.updatedAt)
    }
    return record
  }

  /** The accepted receipt of a command whose effect this transaction commits. */
  function acceptReceipt(receipt: CommandReceipt | null | undefined, result: Record<string, unknown> | null, at: string): void {
    if (receipt === null || receipt === undefined) return
    writeReceipt({
      commandId: receipt.commandId, method: receipt.method, sessionId: receipt.sessionId, inputDigest: receipt.inputDigest,
      outcome: 'accepted', result, error: null, createdAt: receipt.createdAt, updatedAt: at,
    })
  }

  /** Applies a patch to the session row and returns the new session (no clock change). */
  function patchSession(session: Session, patch: SessionPatch): Session {
    const next: Session = {
      ...session,
      ...(patch.externalSessionId !== undefined ? { externalSessionId: patch.externalSessionId } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.nativeTitle !== undefined ? { nativeTitle: patch.nativeTitle } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.sourceAvailability !== undefined ? { sourceAvailability: patch.sourceAvailability } : {}),
      ...(patch.activeTurn !== undefined ? { activeTurn: patch.activeTurn } : {}),
      ...(patch.turnEnded === true ? { latestTurnEndSeq: session.clock.headSeq } : {}),
      ...(patch.planState !== undefined ? { planState: patch.planState } : {}),
      ...(patch.goalState !== undefined ? { goalState: patch.goalState } : {}),
      ...(patch.takeover !== undefined ? { takeover: patch.takeover } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(patch.lastActivityAt !== undefined ? { lastActivityAt: patch.lastActivityAt } : {}),
    }
    run(
      `UPDATE sessions SET external_session_id = ?, cwd = ?, native_title = ?, status = ?, source_availability = ?, active_turn_json = ?,
         latest_turn_end_seq = ?, plan_state = ?, goal_state = ?, takeover = ?, archived = ?, last_activity_at = ?, head_seq = ?, reset_seq = ?
       WHERE session_id = ?`,
      next.externalSessionId, next.cwd, next.nativeTitle, next.status, next.sourceAvailability,
      next.activeTurn === null ? null : json(next.activeTurn), next.latestTurnEndSeq, next.planState, next.goalState,
      next.takeover ? 1 : 0, next.archived ? 1 : 0, next.lastActivityAt, next.clock.headSeq, next.clock.resetSeq, next.sessionId,
    )
    return next
  }

  /** Queues `session.summary` when the facts that matter to the directory changed (domain rule). */
  function publishSummary(session: Session, at: string, force = false): SummaryFacts | null {
    const facts = summarize(session, latestItem(session.sessionId))
    const row = get('SELECT last_summary_json FROM sessions WHERE session_id = ?', session.sessionId)
    const before = row?.last_summary_json === null || row?.last_summary_json === undefined ? null : parse<SummaryFacts>(row.last_summary_json)
    if (!force && !summaryChanged(before, facts)) return null
    run('UPDATE sessions SET last_summary_json = ? WHERE session_id = ?', json(facts), session.sessionId)
    appendOutbox('session.summary', session.sessionId, { summary: facts }, at)
    return facts
  }

  /** The heart of every content change: slim, decide, stamp, tombstone, then summary. */
  function applyTimeline(sessionId: string, change: TimelineChange): SessionCommit {
    let session = requireSession(sessionId)
    const startHead = session.clock.headSeq
    let clock = session.clock
    let reset = false
    if (change.replace !== undefined) {
      clock = raiseResetFence(clock)
      reset = true
    }
    const changed: TimelineItem[] = []
    const deleted: string[] = []
    const stamp = (): number => {
      const next = allocate(clock, 1)
      clock = next.clock
      return next.first
    }
    const kept = new Set<string>()
    for (const raw of change.upserts) {
      const draft: TimelineDraft = slimDraft(raw, blobSink)
      kept.add(draft.id)
      const decision = decideUpsert(sessionId, getItem(sessionId, draft.id) ?? undefined, draft)
      if (decision.kind === 'unchanged') continue
      const item: TimelineItem = { ...decision.item, updatedSeq: stamp(), updatedAt: change.at }
      putItem(item)
      changed.push(item)
    }
    const remove = (itemId: string): void => {
      if (run('DELETE FROM timeline_items WHERE session_id = ? AND item_id = ?', sessionId, itemId).changes === 0) return
      setBlobRefs(sessionId, itemId, [])
      run('INSERT INTO timeline_tombstones(session_id, item_id, updated_seq) VALUES (?, ?, ?) ON CONFLICT(session_id, item_id) DO UPDATE SET updated_seq = excluded.updated_seq', sessionId, itemId, stamp())
      deleted.push(itemId)
    }
    for (const itemId of change.deletes ?? []) remove(itemId)
    if (change.replace !== undefined) {
      const range = change.replace.range
      const rows = range === undefined
        ? all('SELECT item_id FROM timeline_items WHERE session_id = ?', sessionId)
        : all(
          'SELECT item_id FROM timeline_items WHERE session_id = ? AND order_seq > ? AND order_seq <= ?',
          sessionId, range.afterOrderSeq ?? -1, range.throughOrderSeq ?? Number.MAX_SAFE_INTEGER,
        )
      for (const row of rows) if (!kept.has(String(row.item_id))) remove(String(row.item_id))
    }
    session = { ...session, clock }
    writeClock(sessionId, clock)
    const activity = change.session?.lastActivityAt ?? (changed.length > 0 || deleted.length > 0 ? change.at : undefined)
    session = patchSession(session, { ...(change.session ?? {}), ...(activity !== undefined ? { lastActivityAt: activity } : {}) })
    const summary = publishSummary(session, change.at)
    return { session, fromSeq: clock.headSeq > startHead ? startHead + 1 : clock.headSeq, toSeq: clock.headSeq, changed, deleted, reset, summary }
  }

  function noTick(session: Session, summary: SummaryFacts | null): SessionCommit {
    return { session, fromSeq: session.clock.headSeq, toSeq: session.clock.headSeq, changed: [], deleted: [], reset: false, summary }
  }

  // ---------------------------------------------------------------- repositories

  const sessions: Sync<SessionRepository> = {
    create(input: NewSession) {
      return tx(() => {
        const existing = get('SELECT * FROM sessions WHERE session_id = ?', input.sessionId)
        if (existing !== undefined) return { session: sessionFromRow(existing), created: false }
        // A floor the Server gave before this session existed here: its clock starts above it, fence raised.
        const floorRow = get('SELECT seq_floor FROM seq_floors WHERE session_id = ?', input.sessionId)
        const clock: SessionClock = floorRow === undefined ? { headSeq: 0, resetSeq: 0 } : applySeqFloor({ headSeq: 0, resetSeq: 0 }, Number(floorRow.seq_floor)).clock
        run(
          `INSERT INTO sessions(session_id, runtime_type, runtime_id, external_session_id, cwd, project_id, origin_json, native_title, status, source_availability,
             head_seq, reset_seq, takeover, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.sessionId, input.runtimeType, input.runtimeId, input.externalSessionId, input.cwd, input.projectId ?? null, input.origin == null ? null : json(input.origin), input.nativeTitle, input.status,
          input.sourceAvailability, clock.headSeq, clock.resetSeq, input.takeover ? 1 : 0, input.at, input.at,
        )
        if (floorRow !== undefined) run('DELETE FROM seq_floors WHERE session_id = ?', input.sessionId)
        const session = requireSession(input.sessionId)
        publishSummary(session, input.at)
        return { session, created: true }
      })
    },
    get(sessionId) {
      const row = get('SELECT * FROM sessions WHERE session_id = ?', sessionId)
      return row === undefined ? null : sessionFromRow(row)
    },
    list() {
      return all('SELECT * FROM sessions ORDER BY last_activity_at DESC').map(sessionFromRow)
    },
    update(sessionId, patch) {
      return tx(() => {
        const session = patchSession(requireSession(sessionId), patch)
        return noTick(session, publishSummary(session, patch.lastActivityAt ?? now()))
      })
    },
    heads() {
      return all('SELECT session_id, head_seq, reset_seq FROM sessions ORDER BY session_id').map(row => ({
        sessionId: String(row.session_id), headSeq: Number(row.head_seq), resetSeq: Number(row.reset_seq),
      }))
    },
    applySeqFloors(floors) {
      return tx(() => {
        const moved: string[] = []
        for (const [sessionId, floor] of Object.entries(floors)) {
          const row = get('SELECT * FROM sessions WHERE session_id = ?', sessionId)
          if (row === undefined) {
            // Not here yet (a native rescan after a reinstall recreates it under the same id): keep the floor
            // for `create`, so the new clock never starts below what clients already saw.
            applySeqFloor({ headSeq: 0, resetSeq: 0 }, floor) // validates it, as for a session that exists
            run(
              'INSERT INTO seq_floors(session_id, seq_floor) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET seq_floor = MAX(seq_floor, excluded.seq_floor)',
              sessionId, floor,
            )
            continue
          }
          const session = sessionFromRow(row)
          const decision = applySeqFloor(session.clock, floor)
          if (!decision.restamp) continue
          let clock = decision.clock
          // Every existing item must look newer than anything a client saw from the lost store.
          for (const itemRow of all('SELECT payload_json FROM timeline_items WHERE session_id = ? ORDER BY order_seq, item_id', sessionId)) {
            const next = allocate(clock, 1)
            clock = next.clock
            putItem({ ...itemFromRow(itemRow), updatedSeq: next.first })
          }
          run('DELETE FROM timeline_tombstones WHERE session_id = ?', sessionId)
          writeClock(sessionId, clock)
          publishSummary({ ...session, clock }, now(), true)
          moved.push(sessionId)
        }
        return moved
      })
    },
    republishSummaries() {
      return tx(() => {
        const rows = all('SELECT * FROM sessions')
        for (const row of rows) publishSummary(sessionFromRow(row), now(), true)
        return rows.length
      })
    },
  }

  const timeline: Sync<TimelineRepository> = {
    apply(sessionId, change) {
      return tx(() => applyTimeline(sessionId, change))
    },
    get(sessionId, itemId) {
      return getItem(sessionId, itemId)
    },
    latest(sessionId) {
      return latestItem(sessionId)
    },
    read(sessionId: string, mode: ReadMode, cursor: number | null, limit: number, byteBudget: number): TimelinePage {
      const session = requireSession(sessionId)
      const count = Math.max(1, Math.min(limit || STATUS_DEFAULT_LIMIT, PAGE_LIMIT_MAX))
      const budget = byteBudget > 0 ? byteBudget : PAGE_BUDGET
      let rows: Row[]
      if (mode === 'after') {
        rows = all('SELECT payload_json FROM timeline_items WHERE session_id = ? AND order_seq > ? ORDER BY order_seq, item_id LIMIT ?', sessionId, cursor ?? -1, count + 1)
      } else {
        const upper = mode === 'before' && cursor !== null ? cursor : Number.MAX_SAFE_INTEGER
        rows = all('SELECT payload_json FROM timeline_items WHERE session_id = ? AND order_seq < ? ORDER BY order_seq DESC, item_id DESC LIMIT ?', sessionId, mode === 'latest' ? Number.MAX_SAFE_INTEGER : upper, count + 1).reverse()
      }
      const moreByCount = rows.length > count
      const window = moreByCount ? (mode === 'after' ? rows.slice(0, count) : rows.slice(rows.length - count)) : rows
      const fitted = fitPage(window.map(itemFromRow), budget, mode !== 'after')
      const items = fitted.items
      return {
        items,
        headSeq: session.clock.headSeq,
        resetSeq: session.clock.resetSeq,
        hasMore: moreByCount || fitted.truncated,
        oldestOrderSeq: items[0]?.orderSeq ?? null,
        bytes: fitted.bytes,
      }
    },
    changesSince(sessionId, afterSeq, limit, byteBudget): ChangesPage {
      const session = requireSession(sessionId)
      const decision = catchUp(session.clock, afterSeq)
      const base = { toSeq: session.clock.headSeq, resetSeq: session.clock.resetSeq, headSeq: session.clock.headSeq }
      if (decision.kind === 'snapshot_required') return { ...base, items: [], complete: false, snapshotRequired: true }
      if (decision.kind === 'up_to_date') return { ...base, items: [], toSeq: afterSeq, complete: true, snapshotRequired: false }
      const tombstone = get('SELECT 1 AS hit FROM timeline_tombstones WHERE session_id = ? AND updated_seq > ? LIMIT 1', sessionId, afterSeq)
      if (tombstone !== undefined) return { ...base, items: [], complete: false, snapshotRequired: true }
      const count = Math.max(1, Math.min(limit || PAGE_LIMIT_MAX, PAGE_LIMIT_MAX))
      const rows = all('SELECT payload_json FROM timeline_items WHERE session_id = ? AND updated_seq > ? ORDER BY updated_seq LIMIT ?', sessionId, afterSeq, count + 1)
      const window = rows.slice(0, count).map(itemFromRow)
      const fitted = fitPage(window, byteBudget > 0 ? byteBudget : PAGE_BUDGET, false)
      const last = fitted.items[fitted.items.length - 1]
      const complete = rows.length <= count && !fitted.truncated
      // Items are in clock order, so the last one returned is where the client may resume.
      const toSeq = complete ? session.clock.headSeq : (last?.updatedSeq ?? afterSeq)
      return { ...base, items: fitted.items, toSeq, complete, snapshotRequired: false }
    },
    findByClientMessageId(sessionId, clientMessageId) {
      const row = get('SELECT payload_json FROM timeline_items WHERE session_id = ? AND client_message_id = ? ORDER BY order_seq LIMIT 1', sessionId, clientMessageId)
      return row === undefined ? null : itemFromRow(row)
    },
  }

  function getDelivery(sessionId: string, clientMessageId: string): Delivery | null {
    const row = get('SELECT * FROM deliveries WHERE session_id = ? AND client_message_id = ?', sessionId, clientMessageId)
    return row === undefined ? null : deliveryFromRow(row)
  }

  /** `pending` is written on insert only; it is dropped as soon as the delivery leaves `accepted`. */
  function putDelivery(value: Delivery, pending: PendingDelivery | null = null): void {
    run(
      `INSERT INTO deliveries(session_id, client_message_id, state, input_digest, native_ref, error_code, created_at, updated_at, pending_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, client_message_id) DO UPDATE SET state = excluded.state, native_ref = excluded.native_ref, error_code = excluded.error_code, updated_at = excluded.updated_at,
         pending_json = CASE WHEN excluded.state = 'accepted' THEN deliveries.pending_json ELSE NULL END`,
      value.sessionId, value.clientMessageId, value.state, value.inputDigest, value.nativeRef, value.errorCode, value.createdAt, value.updatedAt,
      value.state === 'accepted' && pending !== null ? json(pending) : null,
    )
  }

  function getQueue(sessionId: string): SessionQueue {
    const row = get('SELECT * FROM queues WHERE session_id = ?', sessionId)
    if (row === undefined) return queueRules.emptyQueue(sessionId)
    return { sessionId, revision: Number(row.revision), paused: Number(row.paused) === 1, items: parse<QueueItem[]>(row.items_json) }
  }

  function putQueue(value: SessionQueue): void {
    run(
      'INSERT INTO queues(session_id, revision, paused, items_json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, paused = excluded.paused, items_json = excluded.items_json',
      value.sessionId, value.revision, value.paused ? 1 : 0, json(value.items),
    )
  }

  const deliveries: Sync<DeliveryRepository> = {
    receive(input: ReceiveMessageInput): ReceiveMessageResult {
      return tx(() => {
        requireSession(input.sessionId)
        const existing = getDelivery(input.sessionId, input.clientMessageId)
        const decision = deliveryRules.receive(existing ?? undefined, {
          sessionId: input.sessionId, clientMessageId: input.clientMessageId, inputDigest: input.inputDigest, at: input.at, queued: input.enqueue !== null,
        })
        if (decision.kind === 'duplicate') {
          const queue = getQueue(input.sessionId)
          const queueItem = queue.items.find(item => item.clientMessageId === input.clientMessageId) ?? null
          return { delivery: decision.delivery, duplicate: true, queue: queueItem === null ? null : queue, queueItem, commit: null }
        }
        putDelivery(decision.delivery, input.enqueue === null ? input.pending ?? null : null)
        let queue: SessionQueue | null = null
        let queueItem: QueueItem | null = null
        let commit: SessionCommit | null = null
        if (input.enqueue !== null) {
          const result = queueRules.enqueue(getQueue(input.sessionId), input.enqueue.item, input.enqueue.mode)
          putQueue(result.queue)
          queue = result.queue
          queueItem = result.item
        } else if (input.userItem !== null) {
          commit = applyTimeline(input.sessionId, { upserts: [input.userItem], at: input.at })
        }
        const receiptResult = input.receipt?.result ?? null
        acceptReceipt(input.receipt, queue !== null && queueItem !== null
          ? { ...(receiptResult ?? {}), ...queueRules.queuedDelivery(queue, queueItem.messageId, input.clientMessageId) }
          : receiptResult, input.at)
        return { delivery: decision.delivery, duplicate: false, queue, queueItem, commit }
      })
    },
    get(sessionId, clientMessageId) {
      return getDelivery(sessionId, clientMessageId)
    },
    transition(sessionId, clientMessageId, to, details) {
      return tx(() => {
        const current = getDelivery(sessionId, clientMessageId)
        if (current === null) throw new StoreError('not_found', `delivery ${clientMessageId} not found`)
        if (current.state === to) return current
        const next = deliveryRules.transition(current, to, details.at, {
          ...(details.nativeRef !== undefined ? { nativeRef: details.nativeRef } : {}),
          ...(details.errorCode !== undefined ? { errorCode: details.errorCode } : {}),
        })
        putDelivery(next)
        return next
      })
    },
    inFlight() {
      return all("SELECT * FROM deliveries WHERE state = 'sending'").map(deliveryFromRow)
    },
    acceptedPending() {
      return all("SELECT * FROM deliveries WHERE state = 'accepted' ORDER BY created_at").map(row => ({
        delivery: deliveryFromRow(row),
        pending: row.pending_json === null || row.pending_json === undefined ? null : parse<PendingDelivery>(row.pending_json),
      }))
    },
  }

  /** Queue operations also settle the delivery behind the item, in the same transaction. */
  function settleDeliveryForQueue(sessionId: string, op: QueueOp, before: SessionQueue, at: string): void {
    for (const settlement of queueRules.deliverySettlements(op, before)) {
      const next = queueRules.settleDelivery(getDelivery(sessionId, settlement.clientMessageId), settlement, at)
      if (next !== null) putDelivery(next)
    }
  }

  const queues: Sync<QueueRepository> = {
    get(sessionId) {
      return getQueue(sessionId)
    },
    apply(sessionId, op, at, receipt) {
      return tx(() => {
        const before = getQueue(sessionId)
        const next = queueRules.applyOp(before, op, at)
        if (next !== before) {
          settleDeliveryForQueue(sessionId, op, before, at)
          putQueue(next)
        }
        acceptReceipt(receipt, { ...(receipt?.result ?? {}), ...(queueRules.queueState(next) as unknown as Record<string, unknown>) }, at)
        return next
      })
    },
    nonEmpty() {
      return all("SELECT session_id FROM queues WHERE items_json != '[]'").map(row => getQueue(String(row.session_id)))
    },
  }

  function putInteraction(value: Interaction): void {
    run(
      `INSERT INTO interactions(session_id, notice_id, kind, state, blocking, payload_json, response_id, resolution, opened_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, notice_id) DO UPDATE SET kind = excluded.kind, state = excluded.state, blocking = excluded.blocking, payload_json = excluded.payload_json,
         response_id = excluded.response_id, resolution = excluded.resolution, resolved_at = excluded.resolved_at`,
      value.sessionId, value.noticeId, value.kind, value.state, value.blocking ? 1 : 0, json(value.payload), value.responseId, value.resolution, value.openedAt, value.resolvedAt,
    )
  }

  function getInteraction(sessionId: string, noticeId: string): Interaction | null {
    const row = get('SELECT * FROM interactions WHERE session_id = ? AND notice_id = ?', sessionId, noticeId)
    return row === undefined ? null : interactionFromRow(row)
  }

  const interactions: Sync<InteractionRepository> = {
    save(value) {
      tx(() => putInteraction(value))
    },
    get: getInteraction,
    list(sessionId, activeOnly) {
      const rows = activeOnly
        ? all("SELECT * FROM interactions WHERE session_id = ? AND state IN ('open', 'responding') ORDER BY opened_at, notice_id", sessionId)
        : all('SELECT * FROM interactions WHERE session_id = ? ORDER BY opened_at, notice_id', sessionId)
      return rows.map(interactionFromRow)
    },
    respond(sessionId, noticeId, responseId) {
      return tx(() => {
        const decision = interactionRules.respond(getInteraction(sessionId, noticeId) ?? undefined, responseId)
        if (decision.kind === 'accepted') putInteraction(decision.interaction)
        return { kind: decision.kind, interaction: decision.interaction }
      })
    },
    expireBlocking(sessionId, reason, at) {
      return tx(() => {
        const active = all("SELECT * FROM interactions WHERE session_id = ? AND state IN ('open', 'responding')", sessionId).map(interactionFromRow)
        const closed = interactionRules.closedByTurnEnd(active).map(value => interactionRules.expire(value, reason, at))
        for (const value of closed) putInteraction(value)
        return closed
      })
    },
    allActive() {
      return all("SELECT * FROM interactions WHERE state IN ('open', 'responding') ORDER BY session_id, opened_at").map(interactionFromRow)
    },
  }

  const planning: Sync<PlanningRepository> = {
    load(sessionId) {
      const row = get('SELECT state_json FROM planning_state WHERE session_id = ?', sessionId)
      return row === undefined ? null : parse<PlanningState>(row.state_json)
    },
    save(state: PlanningState, document: PlanDocument | null, receipt?: CommandReceipt | null) {
      return tx(() => {
        if (document !== null) {
          const existing = get('SELECT content_hash FROM plan_documents WHERE session_id = ? AND plan_id = ? AND revision = ?', state.sessionId, document.planId, document.revision)
          if (existing !== undefined && String(existing.content_hash) !== document.contentHash) {
            throw new ConversationError('invalid_transition', `plan ${document.planId} revision ${document.revision} is immutable`)
          }
          if (existing === undefined) {
            run(
              'INSERT INTO plan_documents(session_id, plan_id, revision, content_hash, title, markdown, source_turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              state.sessionId, document.planId, document.revision, document.contentHash, document.title, document.markdown, document.sourceTurnId, document.createdAt,
            )
          }
        }
        run(
          'INSERT INTO planning_state(session_id, state_json, revision) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json, revision = excluded.revision',
          state.sessionId, json(state), state.revision,
        )
        const session = patchSession(requireSession(state.sessionId), { planState: planStateSummary(state) })
        const at = now()
        acceptReceipt(receipt, receipt?.result ?? null, at)
        return noTick(session, publishSummary(session, at))
      })
    },
    document(sessionId, planId, revision) {
      const row = get('SELECT * FROM plan_documents WHERE session_id = ? AND plan_id = ? AND revision = ?', sessionId, planId, revision)
      if (row === undefined) return null
      return {
        planId: String(row.plan_id),
        revision: Number(row.revision),
        contentHash: String(row.content_hash),
        title: String(row.title),
        markdown: String(row.markdown),
        sourceTurnId: nullableString(row.source_turn_id),
        contentState: 'ready',
        createdAt: String(row.created_at),
      }
    },
  }

  const goals: Sync<GoalRepository> = {
    load(sessionId) {
      const row = get('SELECT state_json FROM goal_state WHERE session_id = ?', sessionId)
      return row === undefined ? null : parse<GoalState>(row.state_json)
    },
    save(state: GoalState, receipt?: CommandReceipt | null) {
      return tx(() => {
        run(
          'INSERT INTO goal_state(session_id, state_json, revision) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json, revision = excluded.revision',
          state.sessionId, json(state), state.revision,
        )
        const session = patchSession(requireSession(state.sessionId), { goalState: goalStateSummary(state) })
        const at = now()
        acceptReceipt(receipt, receipt?.result ?? null, at)
        return noTick(session, publishSummary(session, at))
      })
    },
  }

  const commands: Sync<CommandLog> = {
    get(commandId) {
      const row = get('SELECT * FROM operations WHERE operation_id = ?', commandId)
      return row === undefined ? null : commandFromRow(row)
    },
    settle(record) {
      return tx(() => writeReceipt(record))
    },
  }

  const outbox: Sync<OutboxStore> = {
    append(kind, sessionId, payload, at) {
      return tx(() => appendOutbox(kind, sessionId, payload, at))
    },
    pending(afterOid, limit): OutboxRecord[] {
      return all('SELECT * FROM outbox WHERE oid > ? ORDER BY oid LIMIT ?', afterOid, Math.max(1, limit)).map(row => ({
        oid: Number(row.oid),
        kind: String(row.kind),
        sessionId: nullableString(row.session_id),
        payload: parse<Record<string, unknown>>(row.payload_json),
        createdAt: String(row.created_at),
      }))
    },
    ack(oid) {
      return tx(() => Number(run('DELETE FROM outbox WHERE oid <= ?', oid).changes))
    },
    lowest() {
      return nullableNumber(get('SELECT MIN(oid) AS oid FROM outbox')?.oid)
    },
  }

  const blobRepository: Sync<BlobRepository> = {
    put(bytes, meta) {
      return tx(() => putBlob(bytes, meta.mediaType, meta.origin, meta.at))
    },
    get(blobId) {
      const row = get('SELECT * FROM blobs WHERE blob_id = ?', blobId)
      return row === undefined ? null : blobFromRow(row)
    },
    read(blobId, range) {
      const row = get('SELECT sha256 FROM blobs WHERE blob_id = ?', blobId)
      return row === undefined ? null : blobs.read(String(row.sha256), range)
    },
    path(blobId) {
      const row = get('SELECT sha256 FROM blobs WHERE blob_id = ?', blobId)
      return row === undefined ? null : blobs.pathOf(String(row.sha256))
    },
    referencedBy(sessionId, blobId) {
      return get('SELECT 1 AS hit FROM blob_refs WHERE session_id = ? AND blob_id = ? LIMIT 1', sessionId, blobId) !== undefined
    },
  }

  const kv: Sync<RuntimeKv> = {
    get(runtimeId, key) {
      const row = get('SELECT value_json FROM runtime_kv WHERE runtime_id = ? AND key = ?', runtimeId, key)
      return row === undefined ? undefined : parse<unknown>(row.value_json)
    },
    entries(runtimeId) {
      return all('SELECT key, value_json FROM runtime_kv WHERE runtime_id = ?', runtimeId)
        .map(row => ({ key: String(row.key), value: parse<unknown>(row.value_json) }))
    },
    set(runtimeId, key, value) {
      tx(() => {
        run('INSERT INTO runtime_kv(runtime_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(runtime_id, key) DO UPDATE SET value_json = excluded.value_json', runtimeId, key, json(value))
      })
    },
    delete(runtimeId, key) {
      tx(() => {
        run('DELETE FROM runtime_kv WHERE runtime_id = ? AND key = ?', runtimeId, key)
      })
    },
  }

  const preparationRows = (rows: Row[]): Preparation[] => rows.map(row => parse<Preparation>(row.state_json))
  const preparations: Sync<PreparationRepository> = {
    get(preparationId) {
      const row = get('SELECT state_json FROM preparations WHERE preparation_id = ?', preparationId)
      return row === undefined ? null : parse<Preparation>(row.state_json)
    },
    byCreation(createOperationId) {
      const row = get('SELECT state_json FROM preparations WHERE create_operation_id = ?', createOperationId)
      return row === undefined ? null : parse<Preparation>(row.state_json)
    },
    save(preparation) {
      tx(() => {
        const operation = preparation.creation?.createOperationId ?? preparation.reservation?.createOperationId ?? null
        run(
          'INSERT INTO preparations(preparation_id, create_operation_id, phase, state_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(preparation_id) DO UPDATE SET create_operation_id = excluded.create_operation_id, phase = excluded.phase, state_json = excluded.state_json, updated_at = excluded.updated_at',
          preparation.preparationId, operation, preparation.phase, json(preparation), preparation.updatedAt,
        )
      })
    },
    unsettled() {
      return preparationRows(all("SELECT state_json FROM preparations WHERE phase NOT IN ('consumed', 'cancelled', 'expired') OR (phase = 'consumed' AND json_extract(state_json, '$.creation.settled') IS NULL) ORDER BY updated_at"))
    },
    prune(before) {
      return tx(() => Number(run("DELETE FROM preparations WHERE phase IN ('consumed', 'cancelled', 'expired', 'failed', 'outcome_unknown') AND updated_at < ?", before).changes))
    },
  }

  /**
   * At open: timeline blobs no item points at (left by a crash between a blob write and its item, or by stores
   * from before `blob_refs`), files no blob row names, and temporary files of interrupted writes. Files younger
   * than an hour are left alone (a write in flight elsewhere, a clock that went back).
   */
  function sweepBlobs(): void {
    tx(() => {
      for (const row of all("SELECT b.blob_id FROM blobs b WHERE b.origin = 'timeline' AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.blob_id = b.blob_id)")) {
        dropIfUnreferenced(String(row.blob_id))
      }
    })
    const known = new Set(all('SELECT sha256 FROM blobs').map(row => String(row.sha256)))
    for (const entry of blobs.entries(Date.now())) {
      if (entry.ageMs < BLOB_SWEEP_MIN_AGE_MS) continue
      if (entry.sha256 !== null && known.has(entry.sha256)) continue
      blobs.removePath(entry.path)
    }
  }
  if (!readOnly) {
    try {
      sweepBlobs()
    } catch {
      // Cleaning up is never a reason not to open the store.
    }
  }

  const childFromRow = (row: Row): SpawnedChild => ({
    childSessionId: String(row.child_session_id),
    childDeviceId: String(row.child_device_id),
    grantId: String(row.grant_id),
    supervisorSessionId: String(row.supervisor_session_id),
    depth: Number(row.depth),
    closed: Number(row.closed) === 1,
    createdAt: String(row.created_at),
  })
  const collab: Sync<CollabRepository> = {
    putGrant(grant, outboxPayload, at) {
      tx(() => {
        run('INSERT INTO collab_grants(grant_id, supervisor_session_id, secret_digest, state, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(grant_id) DO UPDATE SET state = excluded.state, state_json = excluded.state_json, updated_at = excluded.updated_at',
          grant.grantId, grant.supervisor.sessionId, grant.secretDigest, grant.state, json(grant), at)
        if (outboxPayload !== null) appendOutbox('collab.grant.changed', grant.supervisor.sessionId, outboxPayload as unknown as Record<string, unknown>, at)
      })
    },
    grant(grantId) {
      const row = get('SELECT state_json FROM collab_grants WHERE grant_id = ?', grantId)
      return row === undefined ? null : parse<AgentGrant>(row.state_json)
    },
    grantBySecret(secretDigest) {
      const row = get('SELECT state_json FROM collab_grants WHERE secret_digest = ?', secretDigest)
      return row === undefined ? null : parse<AgentGrant>(row.state_json)
    },
    activeGrantOf(supervisorSessionId) {
      const row = get("SELECT state_json FROM collab_grants WHERE supervisor_session_id = ? AND state = 'active' ORDER BY updated_at DESC LIMIT 1", supervisorSessionId)
      return row === undefined ? null : parse<AgentGrant>(row.state_json)
    },
    activeGrants() {
      return all("SELECT state_json FROM collab_grants WHERE state = 'active'").map(row => parse<AgentGrant>(row.state_json))
    },
    putSupervision(supervision, outboxPayload, at) {
      tx(() => {
        run('INSERT INTO collab_supervisions(supervision_id, supervisor_session_id, target_session_id, state, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(supervision_id) DO UPDATE SET state = excluded.state, state_json = excluded.state_json, updated_at = excluded.updated_at',
          supervision.supervisionId, supervision.supervisor.sessionId, supervision.target.sessionId, supervision.state, json(supervision), at)
        if (outboxPayload !== null) appendOutbox('collab.supervision.changed', supervision.supervisor.sessionId, outboxPayload as unknown as Record<string, unknown>, at)
      })
    },
    supervision(supervisionId) {
      const row = get('SELECT state_json FROM collab_supervisions WHERE supervision_id = ?', supervisionId)
      return row === undefined ? null : parse<Supervision>(row.state_json)
    },
    supervisionsOf(supervisorSessionId, everything) {
      const rows = everything === true
        ? all('SELECT state_json FROM collab_supervisions WHERE supervisor_session_id = ? ORDER BY updated_at DESC', supervisorSessionId)
        : all("SELECT state_json FROM collab_supervisions WHERE supervisor_session_id = ? AND state != 'ended' ORDER BY updated_at DESC", supervisorSessionId)
      return rows.map(row => parse<Supervision>(row.state_json))
    },
    supervisionsOfTarget(targetSessionId) {
      return all("SELECT state_json FROM collab_supervisions WHERE target_session_id = ? AND state != 'ended'", targetSessionId).map(row => parse<Supervision>(row.state_json))
    },
    liveSupervisions() {
      return all("SELECT state_json FROM collab_supervisions WHERE state != 'ended'").map(row => parse<Supervision>(row.state_json))
    },
    putAction(action) {
      tx(() => {
        run('INSERT INTO collab_actions(action_id, supervisor_session_id, state_json, at) VALUES (?, ?, ?, ?) ON CONFLICT(action_id) DO UPDATE SET state_json = excluded.state_json',
          action.actionId, action.supervisor.sessionId, json(action), action.at)
        // The audit keeps the latest 500 actions of a supervisor session.
        run('DELETE FROM collab_actions WHERE supervisor_session_id = ? AND action_id NOT IN (SELECT action_id FROM collab_actions WHERE supervisor_session_id = ? ORDER BY at DESC LIMIT 500)', action.supervisor.sessionId, action.supervisor.sessionId)
      })
    },
    action(actionId) {
      const row = get('SELECT state_json FROM collab_actions WHERE action_id = ?', actionId)
      return row === undefined ? null : parse<AgentAction>(row.state_json)
    },
    recentActions(supervisorSessionId, limit) {
      return all('SELECT state_json FROM collab_actions WHERE supervisor_session_id = ? ORDER BY at DESC LIMIT ?', supervisorSessionId, Math.max(1, limit)).map(row => parse<AgentAction>(row.state_json))
    },
    putChild(child) {
      tx(() => {
        run('INSERT INTO collab_children(child_session_id, child_device_id, grant_id, supervisor_session_id, depth, closed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(child_session_id) DO NOTHING',
          child.childSessionId, child.childDeviceId, child.grantId, child.supervisorSessionId, child.depth, child.closed ? 1 : 0, child.createdAt)
      })
    },
    child(childSessionId) {
      const row = get('SELECT * FROM collab_children WHERE child_session_id = ?', childSessionId)
      return row === undefined ? null : childFromRow(row)
    },
    closeChild(childSessionId) {
      tx(() => {
        run('UPDATE collab_children SET closed = 1 WHERE child_session_id = ?', childSessionId)
      })
    },
    openChildren(supervisorSessionId) {
      return Number(get('SELECT COUNT(*) AS n FROM collab_children WHERE supervisor_session_id = ? AND closed = 0', supervisorSessionId)?.n ?? 0)
    },
    childrenOf(supervisorSessionId) {
      return all('SELECT * FROM collab_children WHERE supervisor_session_id = ? ORDER BY created_at DESC LIMIT 200', supervisorSessionId).map(childFromRow)
    },
    putAuthor(sessionId, clientMessageId, author) {
      tx(() => {
        run('INSERT INTO message_authors(session_id, client_message_id, author_json) VALUES (?, ?, ?) ON CONFLICT(session_id, client_message_id) DO NOTHING', sessionId, clientMessageId, json(author))
      })
    },
    author(sessionId, clientMessageId) {
      const row = get('SELECT author_json FROM message_authors WHERE session_id = ? AND client_message_id = ?', sessionId, clientMessageId)
      return row === undefined ? null : parse<MessageAuthor>(row.author_json)
    },
  }

  return {
    sessions,
    timeline,
    deliveries,
    queues,
    interactions,
    planning,
    goals,
    commands,
    outbox,
    blobs: blobRepository,
    kv,
    preparations,
    collab,
    readOnly,
    storeEpoch,
    close() {
      statements.clear()
      db.close()
    },
  }
}

export { jsonBytes }
