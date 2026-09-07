import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createProjection, type SessionProjection } from './history.js'
import { sessionId } from './identity.js'
import type { NativeChange, NativeRuntime } from './native.js'
import { record, type TimelineItem } from './types.js'

export type SyncOperation = { kind: string, [key: string]: unknown }
export interface SyncBatch { streamId: string, batchSeq: number, projectionVersion: number, operations: SyncOperation[] }
const MAX_BUFFER = 10_000
const MAX_BYTES = 6 * 1024 * 1024

/** One ordered stream. ACK means Connector accepted a page or existing ingest accepted its notifications. */
export class SyncFeed {
  readonly id = randomUUID()
  private batchSeq = 0
  private queue: NativeChange[] = []
  private queuedBytes = 0
  private projections = new Map<string, SessionProjection>()
  private published = new Map<string, string>()
  private waitAck: { seq: number, resolve: () => void, reject: (error: Error) => void } | undefined
  private wake: (() => void) | undefined
  private closed = false
  private unwatch: () => void
  private abort = new AbortController()

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
    this.queue = []; this.projections.clear()
  }
  private async send(operations: SyncOperation[]): Promise<void> {
    this.abort.signal.throwIfAborted()
    const batch: SyncBatch = { streamId: this.id, batchSeq: ++this.batchSeq, projectionVersion: 2, operations }
    if (Buffer.byteLength(JSON.stringify(batch)) > 7 * 1024 * 1024) throw new Error('DSH sync batch exceeds frame size')
    await new Promise<void>((resolve, reject) => {
      this.waitAck = { seq: batch.batchSeq, resolve, reject }
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
    await this.state(id)
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
    const status = pending.size ? 'waiting_approval' : this.native.status(id as SessionId)
      ?? (last?.type === 'turn/end' && last.data.reason.kind === 'error' ? 'error' : 'idle')
    await this.notification('session.state.updated', { sessionId: this.published.get(id), externalSessionId: id, status })
  }
  private async reconcile(): Promise<void> {
    for (const [id, platformId] of this.published) if (!await this.native.visible(id)) {
      await this.notification('session.source.updated', { sessionId: platformId, externalSessionId: id,
        availability: 'hidden', observationOrigin: 'event', observedAt: new Date().toISOString() })
      this.published.delete(id); this.projections.delete(id)
    }
    // Selection can make a previously blank session visible without a new native event.
    for (const id of this.native.candidates()) if (!this.published.has(id)) await this.baseline(id)
    await this.projects()
  }
  private async projects(): Promise<void> {
    const workspaces = this.native.workspaces().map(workspace => ({ ...workspace,
      sessionIds: workspace.sessionIds.flatMap(id => this.published.has(id) ? [this.published.get(id)!] : []) }))
    await this.send([{ kind: 'workspace.inventory', workspaces }])
  }
  private async changes(changes: NativeChange[]): Promise<void> {
    const touched = new Set<string>(), statuses = new Set<string>()
    const ended = new Map<string, Record<string, unknown>>()
    let reconcile = false, projects = false
    for (const change of changes) {
      if (change.type === 'visibility') { reconcile = true; continue }
      if (change.type === 'workspace') { projects = true; continue }
      const { id } = change
      if (!await this.native.visible(id)) {
        if (this.published.has(id)) reconcile = true
        continue
      }
      if (change.type === 'refresh') { await this.baseline(id); projects = true; continue }
      if (!this.published.has(id)) { await this.baseline(id); projects = true }
      if (!this.published.has(id)) continue
      if (change.type === 'event') {
        if (change.event.type === 'turn/end') ended.set(id, {
          sessionId: this.published.get(id), externalSessionId: id,
          sourceObservedAt: new Date(change.event.time).toISOString(),
          outcome: change.event.data.reason.kind === 'error' ? 'failed'
            : ['aborted', 'interrupted'].includes(change.event.data.reason.kind) ? 'interrupted' : 'completed',
        })
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
    else if (projects) await this.projects()
    this.trimProjections()
  }
  private async run(): Promise<void> {
    await this.notification('session.inventory.begin', { scanToken: this.id })
    for (const entry of await this.native.inventory(this.abort.signal)) await this.baseline(entry.header.id)
    await this.changes(this.takeChanges())
    await this.projects()
    await this.notification('session.inventory.complete', { scanToken: this.id, complete: true,
      sessions: [...this.published].map(([externalSessionId, sessionId]) => ({ sessionId, externalSessionId, sourceState: 'visible' })) })
    while (!this.closed) {
      if (!this.queue.length) await new Promise<void>(resolve => { this.wake = resolve })
      if (this.closed) break
      if (this.queue.every(c => c.type === 'event' && c.event.type === 'assistant/chunk')) {
        await new Promise<void>(resolve => setTimeout(resolve, 50))
      }
      await this.changes(this.takeChanges())
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
