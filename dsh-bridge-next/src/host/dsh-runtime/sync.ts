import { jsonBytes } from './json-size.js'
import { PlanDrafts } from './plan-draft.js'
import { randomUUID } from 'node:crypto'
import { receiptKey } from './attachments.js'
import type { SnapshotPage, SnapshotRequest, SnapshotResult, SyncBatch as WireBatch } from '../generated/dsh-sync.js'
import { MeshCallError } from 'meshcall'
import { setTimeout as delay } from 'node:timers/promises'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { createProjection, replayHistory, PROJECTION_VERSION, type SessionProjection } from './history.js'
import { sessionId } from './identity.js'
import type { NativeChange, NativeRuntime } from './native.js'
import { record, type TimelineItem } from './types.js'
import { latestTurnOutcome, turnOutcome, turnOutcomeNotice } from './turn-outcome.js'
import type { SourceState } from './sessions/source.js'

export type SyncOperation = { kind: string, [key: string]: unknown }
export interface SyncCheckpoint { version: 1, projectionVersion: typeof PROJECTION_VERSION, throughSeq: number, historyHash: string, settled: boolean }
/** What the feed needs from the Connector; one call per batch, checkpoint or capture. */
export interface SyncTransport {
  ingestBatch(batch: WireBatch, signal: AbortSignal, attempt?: number): Promise<void>
  loadCheckpoint(externalSessionId: string): Promise<Record<string, unknown> | null>
  saveCheckpoint(externalSessionId: string, checkpoint: SyncCheckpoint): Promise<void>
  deleteCheckpoint(externalSessionId: string): Promise<void>
  ingestSnapshot(request: SnapshotRequest, pages: AsyncIterable<SnapshotPage>, signal: AbortSignal): Promise<SnapshotResult>
}

function matchesCheckpoint(value: unknown, projection: SessionProjection): boolean {
  const checkpoint = record(value)
  return checkpoint.version === 1 && checkpoint.projectionVersion === PROJECTION_VERSION && checkpoint.settled === true
    && projection.settled && checkpoint.throughSeq === projection.throughSeq && checkpoint.historyHash === projection.historyHash
}
const MAX_BUFFER = 10_000
const MAX_QUEUED_BYTES = 16 * 1024 * 1024
const MAX_BYTES = 6 * 1024 * 1024
/** Per-session changes that only say "reread this fact"; one queued copy suffices. */
const SESSION_INVALIDATIONS = new Set(['session', 'status', 'question', 'approval'])
/** Events with notifications or side effects that a recalibrating baseline does not repeat. */
const RETAINED_EVENTS = new Set(['turn/end', 'plan/mode', 'model/selection', 'agent-preset/selected'])
export const MAX_RETAINED_PROJECTIONS = 8
export const SYNC_FLUSH_MS = Math.ceil(1000 / 30)

class SyncTransportError extends Error {}
/** The Connector's code for a Server it cannot reach; see contracts/dsh-bridge/2.0. */
const BACKEND_UNAVAILABLE = 'backend_unavailable'
const BATCH_RETRY_BASE_MS = 1_000
const BATCH_RETRY_MAX_MS = 30_000

/** One ordered subscription. A batch's delivery call returns only after the Connector ingested it. */
export class SyncFeed {
  private readonly planDrafts = new PlanDrafts()
  private batchSeq = 0
  private queue: NativeChange[] = []
  private queuedInvalidations = new Set<string>()
  private queuedBytes = 0
  private lastQueued = new Map<string, NativeChange>()
  private projections = new Map<string, SessionProjection>()
  private published = new Map<string, string>()
  private sourceAvailability = new Map<string, string>()
  private failedSessions = new Map<string, SourceState>()
  private wake: (() => void) | undefined
  private closed = false
  private unwatch: () => void
  private abort = new AbortController()
  private lastSentAt = -Infinity
  private bufferedOperations: SyncOperation[] | undefined
  private bufferedBytes = 0
  private checkpointDirty = new Set<string>()

  get retainedProjectionCount(): number { return this.projections.size }

  constructor(private native: NativeRuntime, private namespace: string, readonly id: string,
    private transport: SyncTransport, private failed: (error: unknown) => void,
    private durableCheckpoints = false) {
    this.unwatch = native.watch(change => {
      if (this.closed) return
      // These events invalidate current facts; replaying every invalidation
      // cannot recover an intermediate value and can starve the initial scan.
      const invalidation = !('id' in change) ? (change.type === 'catalogs' ? `catalogs:${change.catalogType}` : change.type)
        : SESSION_INVALIDATIONS.has(change.type) ? `${change.type}:${change.id}` : undefined
      if (invalidation !== undefined) {
        if (this.queuedInvalidations.has(invalidation)) return
        this.queuedInvalidations.add(invalidation)
      }
      let bytes: number
      try { bytes = jsonBytes(change) }
      catch (error) {
        this.native.diagnostics.log('error', 'sync.event_failed', { streamId: this.id, sessionId: 'id' in change ? change.id : undefined }, error)
        if (!('id' in change)) return
        change = { type: 'refresh', id: change.id }
        bytes = jsonBytes(change)
      }
      this.queuedBytes += bytes
      if (change.type === 'stream' && this.coalesceStream(change)) return
      if (this.queue.length >= MAX_BUFFER || this.queuedBytes > MAX_QUEUED_BYTES) {
        if (!this.compactQueue()) { this.fail(new Error('DSH event buffer full; resubscribe for a fresh baseline')); return }
      }
      // A queued stream change may absorb later chunks, so never share the emitted object.
      const queued = change.type === 'stream' ? { ...change } : change
      this.queue.push(queued)
      if ('id' in queued) this.lastQueued.set(queued.id, queued)
      this.wake?.(); this.wake = undefined
    })
  }
  /**
   * Merges a chunk into the session's last queued change when that is a delta of
   * the same block. Projections and plan drafts concatenate these deltas, so one
   * merged chunk yields the same result while a long reply stays one queue entry.
   */
  private coalesceStream(change: Extract<NativeChange, { type: 'stream' }>): boolean {
    const previous = this.lastQueued.get(change.id)
    if (previous?.type !== 'stream' || previous.turn !== change.turn || previous.step !== change.step
      || previous.throughSeq !== change.throughSeq) return false
    const merged = mergeChunks(previous.chunk, change.chunk)
    if (!merged) return false
    previous.chunk = merged; previous.time = change.time
    return true
  }
  /**
   * Keeps the feed alive when native changes outpace delivery (for example a
   * running Agent while the startup scan uploads a long history). The sessions
   * holding most of the queue give their changes up for one recalibration;
   * events whose notifications a baseline does not repeat stay queued after it.
   */
  private compactQueue(): boolean {
    const sessions = new Map<string, { count: number, bytes: number }>()
    const kinds = new Map<string, number>()
    let length = this.queue.length, bytes = 0
    for (const change of this.queue) {
      const size = jsonBytes(change)
      bytes += size
      kinds.set(change.type, (kinds.get(change.type) ?? 0) + 1)
      if (!('id' in change)) continue
      const session = sessions.get(change.id) ?? { count: 0, bytes: 0 }
      session.count++; session.bytes += size
      sessions.set(change.id, session)
    }
    // Merged chunks are counted at their full size, so recount before dropping anything.
    if (length < MAX_BUFFER && bytes <= MAX_QUEUED_BYTES) { this.queuedBytes = bytes; return true }
    const byCount = length >= MAX_BUFFER
    const collapsed = new Set<string>()
    for (const [id, session] of [...sessions].sort(([, a], [, b]) => byCount ? b.count - a.count : b.bytes - a.bytes)) {
      if (length <= MAX_BUFFER / 2 && bytes <= MAX_QUEUED_BYTES / 2) break
      collapsed.add(id); length -= session.count - 1; bytes -= session.bytes
    }
    if (!collapsed.size) return false
    const kept: NativeChange[] = [], tails = new Map<string, NativeChange[]>()
    const interrupted = new Set<string>()
    for (const change of this.queue) {
      if (!('id' in change) || !collapsed.has(change.id)) { kept.push(change); continue }
      if (change.type === 'refresh' && change.interrupted) interrupted.add(change.id)
      if (change.type === 'event' && RETAINED_EVENTS.has(change.event.type)) {
        tails.set(change.id, [...tails.get(change.id) ?? [], change])
      }
    }
    for (const id of collapsed) {
      for (const type of SESSION_INVALIDATIONS) this.queuedInvalidations.delete(`${type}:${id}`)
      const refresh: NativeChange = { type: 'refresh', id, resume: true, ...interrupted.has(id) ? { interrupted: true } : {} }
      kept.push(refresh, ...tails.get(id) ?? [])
      this.lastQueued.set(id, kept.at(-1)!)
    }
    this.native.diagnostics.log('warn', 'sync.queue_compacted', { streamId: this.id, queuedEvents: this.queue.length,
      remainingEvents: kept.length, sessions: collapsed.size, kinds: [...kinds].map(([type, count]) => `${type}:${count}`).join(',') })
    this.queue = kept
    this.queuedBytes = kept.reduce((total, change) => total + jsonBytes(change), 0)
    return this.queue.length < MAX_BUFFER && this.queuedBytes <= MAX_QUEUED_BYTES
  }
  start(): void {
    this.native.diagnostics.log('info', 'sync.started', { streamId: this.id })
    void this.run().catch(error => { if (!this.closed) this.fail(error) })
  }
  private fail(error: unknown): void {
    this.native.diagnostics.log('error', 'sync.failed', { streamId: this.id, batchSeq: this.batchSeq, queuedEvents: this.queue.length }, error)
    this.close(); this.failed(error)
  }
  close(): void {
    if (this.closed) return
    this.native.diagnostics.log('info', 'sync.stopped', { streamId: this.id, batchSeq: this.batchSeq })
    this.closed = true
    this.abort.abort()
    this.unwatch()
    this.wake?.(); this.wake = undefined
    this.queue = []; this.queuedBytes = 0; this.projections.clear()
    this.queuedInvalidations.clear(); this.lastQueued.clear()
    this.failedSessions.clear()
    this.bufferedOperations = undefined; this.bufferedBytes = 0
  }
  private async send(operations: SyncOperation[]): Promise<void> {
    this.abort.signal.throwIfAborted()
    if (this.bufferedOperations) {
      const bytes = jsonBytes(operations)
      if (this.bufferedOperations.length && this.bufferedBytes + bytes > MAX_BYTES) await this.flushOperations()
      this.abort.signal.throwIfAborted()
      for (const operation of operations) {
        const previous = this.bufferedOperations!.at(-1)
        if (previous?.kind === 'notifications' && operation.kind === 'notifications') {
          (previous.notifications as unknown[]).push(...operation.notifications as unknown[])
        } else this.bufferedOperations!.push(operation)
      }
      this.bufferedBytes += bytes
      return
    }
    await this.transmit(operations)
  }
  private async flushOperations(): Promise<void> {
    const operations = this.bufferedOperations?.splice(0) ?? []
    this.bufferedBytes = 0
    if (operations.length) await this.transmit(operations)
  }
  private async transmit(operations: SyncOperation[]): Promise<void> {
    // Limit actual frames too: pages and status/tool notifications must not bypass the cadence.
    while (performance.now() - this.lastSentAt < SYNC_FLUSH_MS) {
      await delay(Math.ceil(SYNC_FLUSH_MS - (performance.now() - this.lastSentAt)), undefined, { signal: this.abort.signal })
    }
    this.abort.signal.throwIfAborted()
    const batch: WireBatch = { subscriptionId: this.id, batchSeq: ++this.batchSeq, projectionVersion: PROJECTION_VERSION, operations }
    if (jsonBytes(batch) > MAX_BYTES) throw new Error('DSH sync batch exceeds the transport limit')
    this.lastSentAt = performance.now()
    this.native.diagnostics.log('debug', 'sync.batch', { streamId: this.id, batchSeq: batch.batchSeq, operations: operations.length, kinds: operations.map(op => op.kind).join(',') })
    for (let attempt = 0; ; attempt += 1) {
      try {
        // No deadline: a slow upload is a slow answer, and MeshCall keepalives watch the connection.
        await this.transport.ingestBatch(batch, this.abort.signal, attempt)
        break
      } catch (error) {
        // An unreachable Server says nothing about the feed. Ending it would rescan
        // every session on reconnect, and on a slow network that scan fails the same way.
        if (this.closed || !(error instanceof MeshCallError) || error.code !== BACKEND_UNAVAILABLE) {
          throw new SyncTransportError('DSH event delivery failed', { cause: error })
        }
        this.native.diagnostics.log('warn', 'sync.batch_retry', { streamId: this.id, batchSeq: batch.batchSeq, attempt: attempt + 1 }, error)
        await delay(Math.min(BATCH_RETRY_BASE_MS * 2 ** attempt, BATCH_RETRY_MAX_MS), undefined, { signal: this.abort.signal })
      }
    }
    this.native.diagnostics.log('debug', 'sync.ack', { streamId: this.id, batchSeq: batch.batchSeq, elapsedMs: Math.round(performance.now() - this.lastSentAt) })
  }
  private async notification(method: string, params: Record<string, unknown>): Promise<void> {
    await this.send([{ kind: 'notifications', notifications: [{ method, params }] }])
  }
  private async items(id: string, items: TimelineItem[]): Promise<void> {
    let page: TimelineItem[] = [], bytes = 0
    const sendPage = async () => {
      await this.send([{ kind: 'notifications', notifications: page.map(item => ({
        method: 'timeline.itemUpsert', params: { sessionId: item.sessionId, externalSessionId: id, item },
      })) }])
    }
    for (const item of contentItems(items)) {
      const size = jsonBytes(item)
      if (size > MAX_BYTES) throw new Error('A DSH Timeline item exceeds the transport limit')
      if (page.length && (bytes + size > MAX_BYTES || page.length >= 250)) {
        if (!await this.native.visible(id)) return
        await sendPage()
        page = []; bytes = 0
      }
      page.push(item); bytes += size
    }
    if (page.length && await this.native.visible(id)) await sendPage()
  }
  /** Snapshot pages for one capture, bounded like the old snapshot.items frames. */
  private async *pages(items: TimelineItem[], captureId: string): AsyncIterable<SnapshotPage> {
    let page: TimelineItem[] = [], bytes = 0
    for (const item of items) {
      const size = jsonBytes(item)
      if (size > MAX_BYTES) throw new Error('A DSH Timeline item exceeds the transport limit')
      if (page.length && (bytes + size > MAX_BYTES || page.length >= 250)) {
        yield { captureId, items: page as unknown as Record<string, unknown>[] }; page = []; bytes = 0
      }
      page.push(item); bytes += size
    }
    if (page.length) yield { captureId, items: page as unknown as Record<string, unknown>[] }
  }
  private async baseline(id: string, restore = false): Promise<void> {
    await this.sessionOperation(id, 'snapshot', () => this.publishBaseline(id, restore))
  }
  private async publishBaseline(id: string, restore: boolean): Promise<void> {
    if (!await this.native.visible(id)) { await this.unavailable(id); return }
    const start = performance.now()
    let log: Awaited<ReturnType<NativeRuntime['read']>>
    try { log = await this.native.read(id as SessionId) }
    catch (error) {
      // Only native reads are isolated here. Transport/ACK failures below still
      // close the stream so a reconnect can recalibrate unacknowledged data.
      if (this.closed || error instanceof Error && error.name === 'AbortError') throw error
      await this.unavailable(id)
      return
    }
    const platformId = sessionId(this.namespace, id)
    try {
      const projection = createProjection(id, platformId, this.durableCheckpoints)
      let resumed = false
      if (restore && this.durableCheckpoints) {
        const checkpoint = record(await this.delivery(() => this.transport.loadCheckpoint(id)) ?? {})
        if (Number.isSafeInteger(checkpoint.throughSeq) && Number(checkpoint.throughSeq) >= -1) {
          await replayHistory(projection, log, this.abort.signal, Number(checkpoint.throughSeq))
          resumed = matchesCheckpoint(checkpoint, projection)
          if (resumed) projection.drain()
        }
      }
      await replayHistory(projection, log, this.abort.signal)
      const title = log.events.findLast(event => event.type === 'session/title')
      const meta = { externalSessionId: id, title: title?.type === 'session/title' ? title.data.title : null,
        sourceState: await this.native.source.state(id), cwd: log.session.cwd ?? null,
        lastActivityAt: new Date(log.events.at(-1)?.time ?? log.session.createdAt).toISOString() }
      if (resumed) {
        const delta = projection.drain()
        if (!delta.removed.length && await this.native.visible(id)) {
          this.projections.delete(id); this.projections.set(id, projection)
          this.published.set(id, platformId)
          this.sourceAvailability.set(id, 'available')
          await this.notification('session.meta.upsert', { sessionId: platformId, ...meta })
          await this.items(id, delta.items)
          this.checkpointDirty.add(id)
          await this.notices(id)
          await this.state(id, log)
          this.native.diagnostics.log('info', 'sync.checkpoint_restored', { streamId: this.id, sessionId: id })
          return
        }
      }
      if (!await this.native.visible(id)) return
      this.native.diagnostics.log('debug', 'snapshot.started', { streamId: this.id, sessionId: id })
      const snapshotItems = contentItems(projection.snapshot())
      // The capture replaces the timeline: earlier notifications must land first.
      if (this.bufferedOperations?.length) await this.flushOperations()
      // A capture id keeps a cancelled stream's pages from landing in the next capture.
      const captureId = randomUUID()
      const result = await this.delivery(() => this.transport.ingestSnapshot({ captureId, subscriptionId: this.id, sessionId: platformId,
        meta, throughSeq: projection.throughSeq }, this.pages(snapshotItems, captureId), this.abort.signal))
      if (!result.accepted) {
        // Permanently refused: the Connector already published the session as unavailable.
        this.failedSessions.set(id, { availability: 'unavailable', reason: (result.reason ?? 'sync_failed') as string, observedAt: new Date().toISOString() })
        this.native.diagnostics.log('warn', 'snapshot.quarantined', { streamId: this.id, sessionId: id, reason: result.reason ?? undefined })
        return
      }
      this.failedSessions.delete(id)
      projection.drain()
      this.projections.delete(id); this.projections.set(id, projection)
      this.checkpointDirty.add(id)
      this.published.set(id, platformId)
      this.sourceAvailability.set(id, 'available')
      await this.notices(id)
      await this.state(id, log)
      this.native.diagnostics.log('info', 'snapshot.completed', { streamId: this.id, sessionId: id, items: snapshotItems.length, elapsedMs: Math.round(performance.now() - start) })
    } finally {
      this.native.source.release(id)
    }
  }
  private async notices(id: string): Promise<void> {
    for (const notice of [...this.native.questions.notices(this.namespace, id), ...this.native.approvals.notices(this.namespace, id)]) await this.notification('notice.upsert', notice)
  }
  /**
   * A turn that failed or ended without a reply opens an error card; the next
   * turn closes the previous one. Both read the live log, so a card the Bridge
   * opened before a restart is still closed.
   */
  private outcomeNotice(id: string, event: SessionEvent): ReturnType<typeof turnOutcomeNotice> | undefined {
    const events = this.native.ctx.sessions.get(id as SessionId)?.snapshotEvents()
    if (!events) return undefined
    if (event.type === 'turn/start') {
      const previous = latestTurnOutcome(events, Number(event.seq))
      return previous && turnOutcomeNotice(this.namespace, id, previous, 'closed')
    }
    const outcome = turnOutcome(events, Number(event.seq))
    if (!outcome) return undefined
    this.native.diagnostics.log('warn', outcome.kind === 'failed' ? 'turn.failed' : 'turn.no_reply', { streamId: this.id, sessionId: id,
      reason: outcome.reason, steps: outcome.steps, ...(outcome.error ? { code: outcome.error.code } : {}) })
    return turnOutcomeNotice(this.namespace, id, outcome)
  }
  private async state(id: string, snapshot?: SessionLogSnapshot & { bridgeRevision?: string }): Promise<void> {
    if (!this.published.has(id) || !await this.native.visible(id)) return
    const log = this.native.ctx.sessions.get(id as SessionId)
    const pending = new Set<string>()
    for (const e of log?.snapshotEvents() ?? []) {
      if (String(e.type) === 'approval/asked') pending.add(String(record(e.data).id))
      if (String(e.type) === 'approval/decided') pending.delete(String(record(e.data).id))
    }
    const last = log?.snapshotEvents().findLast(e => e.type === 'turn/end')
    const status = pending.size || this.native.questions.waiting(id) || this.native.approvals.waiting(id) ? 'waiting_approval' : this.native.status(id as SessionId)
      ?? (last?.type === 'turn/end' && last.data.reason.kind === 'error' ? 'error' : 'idle')
    let configuration: Awaited<ReturnType<NativeRuntime['configuration']['state']>>
    try {
      configuration = await this.native.diagnostics.measure('session.configuration_read', { sessionId: id }, async () => (await this.native.stateFacts(id as SessionId, snapshot)).configuration)
    } catch (error) {
      if (this.closed || error instanceof Error && error.name === 'AbortError') throw error
      this.native.source.markReadFailed(id)
      await this.unavailable(id)
      return
    }
    await this.notification('session.state.updated', { sessionId: this.published.get(id), externalSessionId: id, status, ...configuration })
  }
  private async reconcile(): Promise<void> {
    for (const id of this.native.candidates()) await this.sessionOperation(id, 'visibility', async () => {
      if (!await this.native.visible(id)) await this.unavailable(id)
    })
    // Recheck source availability; selecting a draft never makes it eligible for import.
    for (const id of this.native.candidates()) if (!this.published.has(id)) await this.baseline(id)
  }
  private async unavailable(id: string): Promise<void> {
    // A capture or checkpoint deletion overtakes buffered notifications otherwise.
    if (this.bufferedOperations?.length) await this.flushOperations()
    const source = await this.sourceState(id)
    // Preserve AA history; a failed read never publishes an empty snapshot.
    // Only feeds that imported this session may create live source updates.
    if (this.sourceAvailability.has(id) && this.sourceAvailability.get(id) !== source.availability) {
      await this.notification('session.source.updated', { sessionId: sessionId(this.namespace, id), externalSessionId: id,
        ...source, observationOrigin: 'event' })
      this.sourceAvailability.set(id, source.availability)
    }
    if (this.durableCheckpoints) await this.delivery(() => this.transport.deleteCheckpoint(id))
    this.published.delete(id); this.projections.delete(id)
  }
  private async sourceState(id: string): Promise<SourceState> {
    const source = await this.native.source.state(id)
    return source.availability === 'available' ? this.failedSessions.get(id) ?? source : source
  }
  /**
   * A delivery failure (network, Server 5xx, deadline) fails the whole feed so
   * the Connector resubscribes and recalibrates. Only durable refusals are
   * reported through the call's own result and isolated per session.
   */
  private async delivery<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) {
      if (this.closed || error instanceof SyncTransportError || error instanceof Error && error.name === 'AbortError') throw error
      throw new SyncTransportError('DSH event delivery failed', { cause: error })
    }
  }
  private async sessionOperation(id: string, phase: string, operation: () => Promise<void>): Promise<void> {
    try { await operation() }
    catch (error) {
      if (this.closed || error instanceof SyncTransportError || error instanceof Error && error.name === 'AbortError') throw error
      this.native.diagnostics.log('error', 'sync.session_failed', { streamId: this.id, sessionId: id, phase }, error)
      this.failedSessions.set(id, { availability: 'unavailable', reason: 'sync_failed', observedAt: new Date().toISOString() })
      await this.unavailable(id)
    }
  }
  private async runtimeOperation(phase: string, operation: () => Promise<void>): Promise<void> {
    try { await operation() }
    catch (error) {
      if (this.closed || error instanceof SyncTransportError || error instanceof Error && error.name === 'AbortError') throw error
      this.native.diagnostics.log('error', 'sync.runtime_update_failed', { streamId: this.id, phase }, error)
    }
  }
  /**
   * Delivers the queued changes of individual sessions while the startup scan
   * still runs, so a session someone is working in streams after its own
   * baseline instead of after the whole inventory (#504). A session that has
   * no baseline yet gets one first; runtime-wide changes and visibility
   * reconciliation wait for the end of the scan.
   */
  private async liveChanges(): Promise<void> {
    const live = this.queue.filter((change): change is Extract<NativeChange, { id: string }> => 'id' in change)
    if (!live.length) return
    this.queue = this.queue.filter(change => !('id' in change))
    const ids = new Set(live.map(change => change.id))
    for (const id of ids) {
      // Later chunks must not merge into a change that is already being delivered.
      this.lastQueued.delete(id)
      for (const kind of SESSION_INVALIDATIONS) this.queuedInvalidations.delete(`${kind}:${id}`)
    }
    this.queuedBytes = this.queue.reduce((total, change) => total + jsonBytes(change), 0)
    // Imported sessions first: another session's capture must not hold up their updates.
    const imported = live.filter(change => this.published.has(change.id))
    const pending = live.filter(change => !this.published.has(change.id))
    let reconcile = await this.deliverLive(imported)
    for (const id of new Set(pending.map(change => change.id))) {
      if (!this.published.has(id) && await this.native.visible(id)) await this.baseline(id, true)
    }
    if (await this.deliverLive(pending)) reconcile = true
    if (reconcile && !this.queuedInvalidations.has('visibility')) {
      this.queuedInvalidations.add('visibility')
      this.queue.push({ type: 'visibility' })
    }
  }
  private async deliverLive(changes: NativeChange[]): Promise<boolean> {
    if (!changes.length) return false
    this.bufferedOperations = []
    const reconcile = await this.changes(changes, false)
    await this.flushOperations()
    this.bufferedOperations = undefined
    return reconcile
  }
  /** Applies changes; returns whether a visibility reconciliation is still due when `reconcileNow` is false. */
  private async changes(changes: NativeChange[], reconcileNow = true): Promise<boolean> {
    const touched = new Set<string>(), statuses = new Set<string>(), capabilities = new Set<string>()
    const ended: [string, Record<string, unknown>][] = []
    const outcomes: [string, ReturnType<typeof turnOutcomeNotice>][] = []
    let reconcile = false, runtimeCapabilities = false, allSessionCapabilities = false
    for (const change of changes) {
      if (change.type === 'capabilities' || change.type === 'commands') {
        runtimeCapabilities = true; allSessionCapabilities = true
        continue
      }
      if (change.type === 'catalogs') {
        if (change.catalogType === 'model' && this.native.ctx.get('llm')) {
          await this.runtimeOperation('models', async () => this.notification('catalog.model.update', { ...await this.native.catalogs.models() }))
        }
        if (change.catalogType === 'permission' && this.native.ctx.get('permissionPresets')) {
          await this.runtimeOperation('permissions', async () => this.notification('catalog.permission.update', this.native.catalogs.permissions()))
        }
        if (change.catalogType === 'model') {
          runtimeCapabilities = true
        }
        continue
      }
      if (change.type === 'visibility') { reconcile = true; continue }
      const { id } = change
      await this.sessionOperation(id, change.type, async () => {
        if (!await this.native.visible(id)) {
          if (this.published.has(id)) reconcile = true
          return
        }
        if (change.type === 'refresh') {
          if (change.interrupted) {
            this.planDrafts.reset(id)
            await this.notification('planning.observed', { sessionId: sessionId(this.namespace, id), externalSessionId: id, kind: 'interrupted' })
          }
          // Notifications already sent from an unsettled projection may include drafts
          // that a checkpoint delta cannot remove; only a full capture replaces them.
          await this.baseline(id, change.resume === true && (this.projections.get(id)?.settled ?? true)); return
        }
        if (!this.published.has(id)) await this.baseline(id)
        if (!this.published.has(id)) return
        if (change.type === 'question' || change.type === 'approval') await this.notices(id)
        if (change.type === 'stream') {
          const mode = await this.native.planning.read(id as SessionId)
          if ('active' in mode && mode.active === false) await this.notification('planning.observed', { sessionId: sessionId(this.namespace, id), externalSessionId: id, kind: 'execution' })
          const draft = this.planDrafts.observe(id, change.turn, change.step, change.chunk)
          if (draft) await this.notification('planning.observed', { sessionId: sessionId(this.namespace, id), externalSessionId: id, ...draft })
          // Running sessions are never evicted. A chunk without a projection waits
          // for the next event to restore it instead of rereading the log per chunk.
          const projection = this.projections.get(id)
          if (!projection) return
          this.projections.delete(id); this.projections.set(id, projection)
          projection.stream(change.turn, change.step, change.chunk, change.time, change.throughSeq)
          touched.add(id)
          return
        }
        if (change.type === 'event') {
          const rawEvent = change.event as unknown as { type: string, data: { active?: boolean } }
          if (rawEvent.type === 'plan/mode' && typeof rawEvent.data.active === 'boolean') await this.notification('planning.observed', { sessionId: sessionId(this.namespace, id), externalSessionId: id, kind: 'mode', mode: rawEvent.data.active ? 'plan' : 'normal' })
          if (['model/selection', 'agent-preset/selected'].includes(change.event.type)) capabilities.add(id)
          if (change.event.type === 'turn/end') {
            this.planDrafts.reset(id)
            await this.notification('planning.observed', { sessionId: sessionId(this.namespace, id), externalSessionId: id, kind: 'interrupted' })
          }
          if (change.event.type === 'turn/end') ended.push([id, {
            sessionId: this.published.get(id), externalSessionId: id,
            sourceObservedAt: new Date(change.event.time).toISOString(),
            outcome: change.event.data.reason.kind === 'error' ? 'failed'
              : ['aborted', 'interrupted'].includes(change.event.data.reason.kind) ? 'interrupted' : 'completed',
          }])
          if (change.event.type === 'turn/start' || change.event.type === 'turn/end') {
            const notice = this.outcomeNotice(id, change.event)
            if (notice) outcomes.push([id, notice])
          }
          if (['turn/start', 'turn/end', 'approval/asked', 'approval/decided', 'model/selection', 'request/header',
            'permission/preset', 'sandbox/mode', 'approval/policy', 'agent-preset/selected'].includes(change.event.type)) statuses.add(id)
          // An evicted projection resumes from its committed checkpoint; the replayed log already holds this event.
          const projection = this.projections.get(id)
          if (!projection) { await this.baseline(id, true); return }
          this.projections.delete(id); this.projections.set(id, projection)
          if (Number(change.event.seq) <= projection.throughSeq) return
          const key = receiptKey(change.event)
          const receipt = key ? (await this.native.attachments.readReceipts(id))[key] : undefined
          try { projection.apply(change.event, receipt) } catch { await this.baseline(id); return }
          touched.add(id)
          this.checkpointDirty.add(id)
          if (change.event.type === 'session/title') await this.notification('session.meta.upsert', {
            sessionId: this.published.get(id), externalSessionId: id, title: change.event.data.title })
        } else statuses.add(id)
      })
    }
    for (const id of touched) await this.sessionOperation(id, 'timeline', async () => {
      const delta = this.projections.get(id)?.drain()
      if (!delta || !await this.native.visible(id)) return
      // Existing ingest has no item-delete notification. Reconcile that session
      // with its complete snapshot when native finalization discards a draft.
      if (delta.removed.length) await this.baseline(id)
      else await this.items(id, delta.items)
    })
    for (const [id, params] of ended) await this.sessionOperation(id, 'turnEnded', async () => {
      if (this.published.has(id) && await this.native.visible(id)) await this.notification('session.turnEnded', params)
    })
    for (const [id, notice] of outcomes) await this.sessionOperation(id, 'turnOutcome', async () => {
      if (this.published.has(id) && await this.native.visible(id)) await this.notification('notice.upsert', notice)
    })
    for (const id of statuses) await this.sessionOperation(id, 'state', () => this.state(id))
    if (runtimeCapabilities) await this.runtimeOperation('capabilities', async () => this.notification('runtime.capability.updated', await this.native.capabilities()))
    if (allSessionCapabilities) for (const id of this.published.keys()) capabilities.add(id)
    for (const id of capabilities) await this.sessionOperation(id, 'capabilities', async () => {
      if (this.published.has(id)) await this.notification('session.capability.updated', await this.native.capabilities(this.published.get(id), id as SessionId))
    })
    if (!reconcileNow) return reconcile
    if (reconcile) await this.reconcile()
    return false
  }
  private async run(): Promise<void> {
    await this.notification('session.inventory.begin', { scanToken: this.id })
    await this.native.inventory(this.abort.signal, async entry => {
      // A session the live changes below already imported needs no second capture.
      if (!this.published.has(entry.header.id)) await this.baseline(entry.header.id, true)
      await this.liveChanges()
      await this.rememberCheckpoints()
      this.trimProjections()
    })
    // Startup changes use the same batching as live changes. Otherwise one
    // capability update incurs a separate transport round trip per session.
    this.bufferedOperations = []
    await this.changes(this.takeChanges())
    const sessions = []
    for (const id of this.native.candidates()) sessions.push({ sessionId: sessionId(this.namespace, id),
      externalSessionId: id, sourceState: await this.sourceState(id) })
    await this.notification('session.inventory.complete', { scanToken: this.id, complete: true,
      sessions })
    await this.flushOperations()
    // Checkpoints cover the data above: save only after the batch was ingested.
    await this.rememberCheckpoints()
    this.trimProjections()
    this.bufferedOperations = undefined
    this.native.diagnostics.log('info', 'sync.inventory_completed', { streamId: this.id, sessions: this.published.size })
    while (!this.closed) {
      if (!this.queue.length) await new Promise<void>(resolve => { this.wake = resolve })
      if (this.closed) break
      // Collect all native changes in one bounded window; projection.drain()
      // keeps the latest revision of each item without dropping native deltas.
      await delay(SYNC_FLUSH_MS, undefined, { signal: this.abort.signal })
      this.bufferedOperations = []
      await this.changes(this.takeChanges())
      // The checkpoint covers this frame's data, so the batch must be ingested first.
      await this.flushOperations()
      await this.rememberCheckpoints()
      this.trimProjections()
      this.bufferedOperations = undefined
    }
  }
  private async rememberCheckpoints(): Promise<void> {
    if (!this.durableCheckpoints) { this.checkpointDirty.clear(); return }
    for (const id of this.checkpointDirty) {
      const projection = this.projections.get(id)
      if (!projection || !this.published.has(id) || this.failedSessions.has(id)) continue
      const checkpoint: SyncCheckpoint = { version: 1, projectionVersion: PROJECTION_VERSION,
        throughSeq: projection.throughSeq, historyHash: projection.historyHash!, settled: projection.settled }
      await this.transport.saveCheckpoint(id, checkpoint)
    }
    this.checkpointDirty.clear()
  }
  /**
   * Only a committed durable checkpoint lets baseline(id, true) resume an evicted
   * session with a delta; without one, eviction would re-upload its whole history.
   * Running or interactive sessions keep their projection for continuous streaming.
   */
  private canEvictProjection(id: string, projection: SessionProjection): boolean {
    if (!this.durableCheckpoints || this.checkpointDirty.has(id) || this.failedSessions.has(id)) return false
    if (!projection.settled || projection.dirty || this.native.status(id as SessionId) === 'running') return false
    return !this.native.questions.waiting(id) && !this.native.approvals.waiting(id)
  }
  private trimProjections(maxRetained = MAX_RETAINED_PROJECTIONS): void {
    // Cold sessions cannot stream; live ones keep the most recently used projections.
    for (const [id, projection] of this.projections) {
      if (!this.native.ctx.sessions.get(id as SessionId) && this.canEvictProjection(id, projection)) {
        this.projections.delete(id)
      }
    }
    if (this.projections.size <= maxRetained) return
    for (const [id, projection] of this.projections) {
      if (this.projections.size <= maxRetained) break
      if (this.canEvictProjection(id, projection)) {
        this.projections.delete(id)
      }
    }
  }
  private takeChanges(): NativeChange[] {
    this.queuedBytes = 0; this.queuedInvalidations.clear(); this.lastQueued.clear()
    return this.queue.splice(0)
  }

}

/** One chunk with the effect of applying `a` then `b`, or undefined when they are not deltas of one block. */
function mergeChunks(a: StreamChunk, b: StreamChunk): StreamChunk | undefined {
  if (!('index' in a) || !('index' in b) || a.index !== b.index) return undefined
  if ((a.type === 'text-delta' && b.type === 'text-delta') || (a.type === 'reasoning-delta' && b.type === 'reasoning-delta')) {
    return { ...a, text: a.text + b.text }
  }
  if (a.type === 'tool-call-delta' && b.type === 'tool-call-delta' && a.id === b.id) {
    const name = b.name ?? a.name
    return { ...a, ...name === undefined ? {} : { name }, argumentsDelta: a.argumentsDelta + b.argumentsDelta }
  }
  return undefined
}

function contentItems(items: TimelineItem[]): TimelineItem[] {
  // Lifecycle belongs to session.state.updated / session.turnEnded in the platform.
  return items.filter(item => item.type !== 'turn.start' && item.type !== 'turn.end')
}
