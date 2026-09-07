import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createProjection, type SessionProjection } from './history.js'
import { sessionId } from './identity.js'
import type { NativeChange, NativeRuntime } from './native.js'
import { record, type TimelineItem } from './types.js'
import { capabilities } from './capabilities.js'

export type SyncOperation = { kind: string, [key: string]: unknown }
export interface SyncBatch { streamId: string, batchSeq: number, projectionVersion: number, operations: SyncOperation[] }
const MAX_BUFFER = 10_000
const MAX_BYTES = 6 * 1024 * 1024
export const SYNC_FLUSH_MS = Math.ceil(1000 / 30)

/** One ordered stream. ACK means Connector accepted a page or existing ingest accepted its notifications. */
export class SyncFeed {
  readonly id = randomUUID()
  private batchSeq = 0
  private queue: NativeChange[] = []
  private queuedBytes = 0
  private projections = new Map<string, SessionProjection>()
  private published = new Map<string, string>()
  private sourceAvailability = new Map<string, string>()
  private waitAck: { seq: number, resolve: () => void, reject: (error: Error) => void } | undefined
  private wake: (() => void) | undefined
  private closed = false
  private unwatch: () => void
  private abort = new AbortController()
  private lastSentAt = -Infinity
  private bufferedOperations: SyncOperation[] | undefined
  private bufferedBytes = 0

  constructor(private native: NativeRuntime, private namespace: string,
    private notify: (batch: SyncBatch) => void, private failed: (error: unknown) => void) {
    this.unwatch = native.watch(change => {
      if (this.closed) return
      this.queuedBytes += Buffer.byteLength(JSON.stringify(change))
      if (this.queue.length >= MAX_BUFFER || this.queuedBytes > 16 * 1024 * 1024) { this.fail(new Error('DSH event buffer full; resubscribe for a fresh baseline')); return }
      this.queue.push(change)
      this.wake?.(); this.wake = undefined
    })
  }
  start(): void { void this.run().catch(error => { if (!this.closed) this.fail(error) }) }
  private fail(error: unknown): void { this.close(); this.failed(error) }
  ack(seq: number): void {
    if (seq > this.batchSeq || !Number.isSafeInteger(seq)) throw new Error('Invalid event acknowledgement')
    if (this.waitAck?.seq === seq) { const pending = this.waitAck; this.waitAck = undefined; pending.resolve() }
  }
  close(): void {
    this.closed = true
    this.abort.abort()
    this.unwatch()
    this.waitAck?.reject(new Error('DSH sync closed'))
    this.waitAck = undefined
    this.wake?.(); this.wake = undefined
    this.queue = []; this.queuedBytes = 0; this.projections.clear()
    this.bufferedOperations = undefined; this.bufferedBytes = 0
  }
  private async send(operations: SyncOperation[]): Promise<void> {
    this.abort.signal.throwIfAborted()
    if (this.bufferedOperations) {
      const bytes = Buffer.byteLength(JSON.stringify(operations))
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
    const batch: SyncBatch = { streamId: this.id, batchSeq: ++this.batchSeq, projectionVersion: 2, operations }
    if (Buffer.byteLength(JSON.stringify(batch)) > 7 * 1024 * 1024) throw new Error('DSH sync batch exceeds frame size')
    await new Promise<void>((resolve, reject) => {
      this.waitAck = { seq: batch.batchSeq, resolve, reject }
      this.lastSentAt = performance.now()
      try { this.notify(batch) } catch (error) { this.waitAck = undefined; reject(error) }
    })
  }
  private async notification(method: string, params: Record<string, unknown>): Promise<void> {
    await this.send([{ kind: 'notifications', notifications: [{ method, params }] }])
  }
  private async items(kind: string, id: string, items: TimelineItem[], snapshotId?: string): Promise<void> {
    let page: TimelineItem[] = [], bytes = 0
    const sendPage = async () => {
      if (snapshotId) await this.send([{ kind, sessionId: sessionId(this.namespace, id), items: page, snapshotId }])
      else await this.send([{ kind: 'notifications', notifications: page.map(item => ({
        method: 'timeline.itemUpsert', params: { sessionId: item.sessionId, externalSessionId: id, item },
      })) }])
    }
    for (const item of contentItems(items)) {
      const size = Buffer.byteLength(JSON.stringify(item))
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
  private async baseline(id: string): Promise<void> {
    if (!await this.native.visible(id)) return
    const log = await this.native.read(id as SessionId)
    const platformId = sessionId(this.namespace, id)
    const projection = createProjection(id, platformId)
    for (const event of log.events) projection.apply(event)
    const title = log.events.findLast(event => event.type === 'session/title')
    const snapshotId = randomUUID()
    if (!await this.native.visible(id)) return
    await this.send([{ kind: 'snapshot.begin', sessionId: platformId, snapshotId,
      meta: { externalSessionId: id, title: title?.type === 'session/title' ? title.data.title : null,
        sourceState: await this.native.source.state(id),
        cwd: log.session.cwd ?? null,
        lastActivityAt: new Date(log.events.at(-1)?.time ?? log.session.createdAt).toISOString() },
      throughSeq: projection.throughSeq }])
    await this.items('snapshot.items', id, projection.snapshot(), snapshotId)
    if (!await this.native.visible(id)) {
      await this.send([{ kind: 'snapshot.abort', sessionId: platformId, snapshotId }]); return
    }
    await this.send([{ kind: 'snapshot.commit', sessionId: platformId, snapshotId,
      totalItems: contentItems(projection.snapshot()).length, throughSeq: projection.throughSeq }])
    projection.drain()
    this.projections.set(id, projection)
    // Bound retained history across idle sessions. A later event rehydrates only
    // that evicted session; no background history scans are introduced.
    this.trimProjections()
    this.published.set(id, platformId)
    this.sourceAvailability.set(id, 'available')
    await this.notices(id)
    await this.state(id)
  }
  private async notices(id: string): Promise<void> {
    for (const notice of this.native.questions.notices(this.namespace, id)) await this.notification('notice.upsert', notice)
  }
  private async state(id: string): Promise<void> {
    if (!this.published.has(id) || !await this.native.visible(id)) return
    const log = this.native.ctx.sessions.get(id as SessionId)
    const pending = new Set<string>()
    for (const e of log?.snapshotEvents() ?? []) {
      if (String(e.type) === 'approval/asked') pending.add(String(record(e.data).id))
      if (String(e.type) === 'approval/decided') pending.delete(String(record(e.data).id))
    }
    const last = log?.snapshotEvents().findLast(e => e.type === 'turn/end')
    const status = pending.size || this.native.questions.waiting(id) ? 'waiting_approval' : this.native.status(id as SessionId)
      ?? (last?.type === 'turn/end' && last.data.reason.kind === 'error' ? 'error' : 'idle')
    await this.notification('session.state.updated', { sessionId: this.published.get(id), externalSessionId: id, status })
  }
  private async reconcile(): Promise<void> {
    for (const id of this.native.candidates()) if (!await this.native.visible(id)) {
      const source = await this.native.source.state(id)
      // Source notifications can create rows in the existing ingest API too.
      // Only report changes for sessions this feed has already imported.
      if (this.sourceAvailability.has(id) && this.sourceAvailability.get(id) !== source.availability) {
        await this.notification('session.source.updated', { sessionId: sessionId(this.namespace, id), externalSessionId: id,
          ...source, observationOrigin: 'event' })
        this.sourceAvailability.set(id, source.availability)
      }
      this.published.delete(id); this.projections.delete(id)
    }
    // Recheck source availability; selecting a draft never makes it eligible for import.
    for (const id of this.native.candidates()) if (!this.published.has(id)) await this.baseline(id)
  }
  private async changes(changes: NativeChange[]): Promise<void> {
    const touched = new Set<string>(), statuses = new Set<string>()
    const ended: [string, Record<string, unknown>][] = []
    let reconcile = false
    for (const change of changes) {
      if (change.type === 'capabilities') {
        await this.notification('runtime.capability.updated', capabilities(undefined, Boolean(this.native.ctx.get('agents')), this.native.questions.available))
        continue
      }
      if (change.type === 'visibility') { reconcile = true; continue }
      const { id } = change
      if (!await this.native.visible(id)) {
        if (this.published.has(id)) reconcile = true
        continue
      }
      if (change.type === 'refresh') { await this.baseline(id); continue }
      if (!this.published.has(id)) await this.baseline(id)
      if (!this.published.has(id)) continue
      if (change.type === 'question') await this.notices(id)
      if (change.type === 'event') {
        if (change.event.type === 'turn/end') ended.push([id, {
          sessionId: this.published.get(id), externalSessionId: id,
          sourceObservedAt: new Date(change.event.time).toISOString(),
          outcome: change.event.data.reason.kind === 'error' ? 'failed'
            : ['aborted', 'interrupted'].includes(change.event.data.reason.kind) ? 'interrupted' : 'completed',
        }])
        if (['turn/start', 'turn/end', 'approval/asked', 'approval/decided'].includes(change.event.type)) statuses.add(id)
        const projection = this.projections.get(id)
        if (!projection) { await this.baseline(id); continue }
        this.projections.delete(id); this.projections.set(id, projection)
        if (Number(change.event.seq) <= projection.throughSeq) continue
        try { projection.apply(change.event) } catch { await this.baseline(id); continue }
        touched.add(id)
        if (change.event.type === 'session/title') await this.notification('session.meta.upsert', {
          sessionId: this.published.get(id), externalSessionId: id, title: change.event.data.title })
      } else statuses.add(id)
    }
    for (const id of touched) {
      const delta = this.projections.get(id)?.drain()
      if (!delta || !await this.native.visible(id)) continue
      // Existing ingest has no item-delete notification. Reconcile that session
      // with its complete snapshot when native finalization discards a draft.
      if (delta.removed.length) await this.baseline(id)
      else await this.items('timeline.upsert', id, delta.items)
    }
    for (const [id, params] of ended) if (await this.native.visible(id)) await this.notification('session.turnEnded', params)
    for (const id of statuses) await this.state(id)
    if (reconcile) await this.reconcile()
    this.trimProjections()
  }
  private async run(): Promise<void> {
    await this.notification('session.inventory.begin', { scanToken: this.id })
    const inventory = await this.native.inventory(this.abort.signal)
    for (const entry of inventory) await this.baseline(entry.header.id)
    await this.changes(this.takeChanges())
    const sessions = []
    for (const id of this.native.candidates()) sessions.push({ sessionId: sessionId(this.namespace, id),
      externalSessionId: id, sourceState: await this.native.source.state(id) })
    await this.notification('session.inventory.complete', { scanToken: this.id, complete: true,
      sessions })
    while (!this.closed) {
      if (!this.queue.length) await new Promise<void>(resolve => { this.wake = resolve })
      if (this.closed) break
      // Collect all native changes in one bounded window; projection.drain()
      // keeps the latest revision of each item without dropping native deltas.
      await delay(SYNC_FLUSH_MS, undefined, { signal: this.abort.signal })
      this.bufferedOperations = []
      await this.changes(this.takeChanges())
      await this.flushOperations()
      this.bufferedOperations = undefined
    }
  }
  private takeChanges(): NativeChange[] { this.queuedBytes = 0; return this.queue.splice(0) }
  private trimProjections(): void {
    for (const [id, projection] of this.projections) {
      if (this.projections.size <= 16) break
      if (!projection.dirty) this.projections.delete(id)
    }
  }
}

function contentItems(items: TimelineItem[]): TimelineItem[] {
  // Lifecycle belongs to session.state.updated / session.turnEnded in the platform.
  return items.filter(item => item.type !== 'turn.start' && item.type !== 'turn.end')
}
