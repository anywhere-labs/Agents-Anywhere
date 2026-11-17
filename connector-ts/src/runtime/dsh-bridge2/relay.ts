/**
 * The Connector half of `dsh-bridge 2.0` sync for plugins that are already installed
 * (DSH-3; contracts/dsh-bridge/2.0). An acknowledgement and a checkpoint mean
 * "committed to the Connector's local store", not "accepted by the Server"
 * (04-connector.md §5.6); plugins cannot tell the difference.
 *
 * The 2.0 plugin sends notifications it already projected onto the platform timeline
 * (`timeline.itemUpsert`, `session.meta.upsert`, …), so they go to the local store as
 * they are, through `Bridge2Ledger`, instead of through `RuntimeEvent`s.
 *
 * Transport-free: `service.ts` binds it to MeshCall, tests drive it directly.
 */

export const SUBSCRIPTION_UNKNOWN = 'subscription_unknown'
export const BACKEND_UNAVAILABLE = 'backend_unavailable'
/** Projection versions this Connector understands (plugin 2.x `PROJECTION_VERSION`). */
export const SUPPORTED_PROJECTION_VERSIONS: ReadonlySet<number> = new Set([2, 3])
/** Once two batches in a row carry only running items, each is acknowledged no sooner than this after its commit began. */
export const STREAMING_POST_INTERVAL_MS = 250
/** How long a batch waits for its subscription's `subscribed` item. */
export const SUBSCRIBE_CONFIRM_TIMEOUT_MS = 30_000
export const QUARANTINE_RETRY_MS = 30_000
export const QUARANTINE_TOO_LARGE_RETRY_MS = 5 * 60_000
export const QUARANTINE_MAX_RETRY_MS = 30 * 60_000
export const MAX_RESUBSCRIBE_DELAY_MS = 30_000

/** Notifications the plugin may send while checkpoints are durable; they commit together. */
const DURABLE_NOTIFICATIONS = new Set(['timeline.itemUpsert', 'session.meta.upsert', 'session.state.updated',
  'session.source.updated', 'session.turnEnded', 'session.inventory.begin', 'session.inventory.complete'])
/** History withheld for a quarantined session: it would land on a timeline that never got its baseline. */
const QUARANTINED_HISTORY = new Set(['timeline.itemUpsert', 'session.turnEnded'])
/** Every notification method a 2.0 plugin sends (connector/runtimes/dsh/bridge/sync.py `publish_notification`). */
export const BRIDGE2_NOTIFICATIONS: ReadonlySet<string> = new Set([...DURABLE_NOTIFICATIONS, 'planning.observed', 'notice.upsert',
  'runtime.capability.updated', 'session.capability.updated', 'catalog.model.update', 'catalog.permission.update'])

export type Json = Record<string, unknown>
export interface Notification { method: string, params: Json }
export interface SyncBatch { subscriptionId: string, batchSeq: number, projectionVersion: number, operations: Json[] }
export interface SnapshotRequest { captureId: string, subscriptionId: string, sessionId: string, meta: Json, throughSeq: number }
export interface SnapshotPage { captureId: string, items: Json[] }
export interface SnapshotResult { accepted: boolean, quarantined?: boolean, reason?: string | null }
export interface Checkpoint { version: 1, projectionVersion: 2 | 3, throughSeq: number, historyHash: string, settled: boolean }

/** Errors the plugin understands, carried as MeshCall application error codes by the binding. */
export class Bridge2Error extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message) }
}

/** The local store refused a history for good; retrying will not help. */
export class HistoryRefusedError extends Error {
  constructor(readonly reason: 'history_too_large' | 'history_rejected', message: string = reason) { super(message) }
}

/**
 * Where ingested 2.0 notifications go: the Connector's local store (A, `store/`). Each
 * method resolves only once the change is committed locally; that is the acknowledgement.
 * Throw `Bridge2Error(BACKEND_UNAVAILABLE, …, true)` for a transient failure: the plugin
 * sends the same batch again instead of ending the feed.
 */
export interface Bridge2Ledger {
  /** Commit one batch's notifications, in order, atomically. */
  publish(notifications: readonly Notification[]): Promise<void>
  /** Replace one session's timeline with a complete capture; throw `HistoryRefusedError` to quarantine it. */
  replaceSession(sessionId: string, meta: Json, items: readonly Json[]): Promise<void>
  readState(key: string): Promise<unknown>
  writeState(key: string, value: Json): Promise<void>
  deleteState(key: string): Promise<void>
}

/** Calls into the plugin's `aa.dsh.v2.Bridge` (see `client.ts`). */
export interface Bridge2Calls {
  request(method: string, params?: Json): Promise<Json>
  stream(method: string, params: Json, signal: AbortSignal): AsyncIterable<Json>
}

export const checkpointKey = (externalSessionId: string) => `dsh/sync/checkpoints/${externalSessionId}`

/** sync.py `_checkpoint`: only a well-formed version 1 checkpoint is stored or handed back. */
export function parseCheckpoint(value: unknown): Checkpoint | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Json
  const seq = v.throughSeq
  const hash = v.historyHash
  if (v.version !== 1 || (v.projectionVersion !== 2 && v.projectionVersion !== 3)
    || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < -1
    || typeof v.settled !== 'boolean' || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null
  return { version: 1, projectionVersion: v.projectionVersion, throughSeq: seq, historyHash: hash, settled: v.settled }
}

/** sync.py `_event_time`: a DSH event time (epoch milliseconds) in the backend's ISO form. */
function eventTime(value: unknown): string | undefined {
  if (typeof value !== 'number' || !(value > 0)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * Dates replayed items that have no time by their own DSH event
 * time, else by the session's last activity, so a re-capture does not re-sort sessions.
 */
export function withEventTime(items: readonly Json[], activity: unknown): Json[] {
  const fallback = typeof activity === 'string' && activity ? activity : undefined
  return items.map(item => {
    const source = item.source
    const time = (typeof source === 'object' && source !== null ? eventTime((source as Json).time) : undefined) ?? fallback
    return time === undefined ? item : { createdAt: time, updatedAt: time, ...item }
  })
}

function isStreamingDraft(notice: Notification): boolean {
  const item = notice.params.item
  return notice.method === 'timeline.itemUpsert' && typeof item === 'object' && item !== null && (item as Json).status === 'running'
}

function notification(raw: unknown): Notification {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid runtime notification')
  const { method, params } = raw as Json
  if (typeof method !== 'string' || typeof params !== 'object' || params === null || Array.isArray(params)) throw new Error('Invalid runtime notification')
  if (!BRIDGE2_NOTIFICATIONS.has(method)) throw new Error(`Unsupported runtime notification: ${method}`)
  if (method === 'timeline.itemUpsert') {
    const item = (params as Json).item as Json | undefined
    if (!item || typeof item.id !== 'string' || item.sessionId !== (params as Json).sessionId) throw new Error('Incremental item belongs to a different session')
  }
  return { method, params: params as Json }
}

interface Quarantine { externalSessionId: string | null, reason: 'history_too_large' | 'history_rejected', attempts: number, retryAt: number, stale: boolean }
interface Capture { captureId: string, sessionId: string, meta: Json, throughSeq: number, items: Json[], ids: Set<string>, withheld: boolean }

export interface RelayOptions {
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  retryMs?: number
  tooLargeRetryMs?: number
  streamingIntervalMs?: number
  confirmTimeoutMs?: number
  newSubscriptionId?: () => string
  /** `session.inventory.complete` with `complete: true` was committed: the baseline is in. */
  onBaseline?: () => void
  onError?: (event: string, error: unknown) => void
}

/** A promise-chain mutex: batches, checkpoints and captures never interleave. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => undefined)
    return next
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms)
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
  signal?.addEventListener('abort', done, { once: true })
})

/**
 * The relay for one plugin connection. `run()` keeps a subscription open and opens a
 * new one (fresh ID, batch sequence back at 1) whenever the plugin ends the previous.
 */
export class Bridge2SyncRelay {
  subscriptionId: string | undefined
  projectionVersion: number | undefined
  durableCheckpoints = false
  readonly quarantined = new Map<string, Quarantine>()
  private expectedBatch = 1
  private confirmed: Promise<void> = Promise.resolve()
  private confirm: () => void = () => undefined
  private lastDraftPost: number | undefined
  private capture: Capture | undefined
  private readonly serial = new Serial()
  private readonly abort = new AbortController()
  private readonly retries = new Set<Promise<void>>()
  private readonly options: Required<Omit<RelayOptions, 'onBaseline' | 'onError'>> & { onBaseline: (() => void) | undefined, onError: ((event: string, error: unknown) => void) | undefined }

  constructor(private readonly ledger: Bridge2Ledger, private readonly calls: Bridge2Calls, options: RelayOptions = {}) {
    this.options = {
      now: options.now ?? Date.now,
      sleep: options.sleep ?? defaultSleep,
      retryMs: options.retryMs ?? QUARANTINE_RETRY_MS,
      tooLargeRetryMs: options.tooLargeRetryMs ?? QUARANTINE_TOO_LARGE_RETRY_MS,
      streamingIntervalMs: options.streamingIntervalMs ?? STREAMING_POST_INTERVAL_MS,
      confirmTimeoutMs: options.confirmTimeoutMs ?? SUBSCRIBE_CONFIRM_TIMEOUT_MS,
      newSubscriptionId: options.newSubscriptionId ?? (() => crypto.randomUUID().replaceAll('-', '')),
      onBaseline: options.onBaseline,
      onError: options.onError,
    }
  }

  get closed(): boolean { return this.abort.signal.aborted }

  /** Resubscribe with a growing delay until `close()` or `connected()` turns false. */
  async run(connected: () => boolean = () => true): Promise<void> {
    let failures = 0
    while (!this.closed) {
      try {
        await this.subscribe(this.options.newSubscriptionId(), this.abort.signal, () => { failures = 0 })
      } catch (error) {
        if (this.closed) return
        failures += 1
        this.options.onError?.('sync.interrupted', error)
        if (!connected()) return
        await this.options.sleep(Math.min(1000 * 2 ** (failures - 1), MAX_RESUBSCRIBE_DELAY_MS), this.abort.signal)
      }
    }
  }

  /** One subscription: open the plugin's sync stream and keep it open. */
  async subscribe(subscriptionId: string, signal: AbortSignal, onSubscribed?: () => void): Promise<void> {
    this.subscriptionId = subscriptionId
    this.projectionVersion = undefined
    this.expectedBatch = 1
    this.lastDraftPost = undefined
    this.confirmed = new Promise(resolve => { this.confirm = resolve })
    try {
      for await (const event of this.calls.stream('sync', { subscriptionId, checkpointVersion: 1 }, signal)) {
        if (event.kind !== 'subscribed') continue
        if (typeof event.projectionVersion !== 'number' || !SUPPORTED_PROJECTION_VERSIONS.has(event.projectionVersion)) {
          throw new Error('Unsupported DSH projection version')
        }
        this.durableCheckpoints = event.checkpointVersion === 1
        this.projectionVersion = event.projectionVersion
        this.confirm()
        onSubscribed?.()
      }
      if (!signal.aborted) throw new Error('The DSH plugin ended the sync stream')
    } finally {
      if (this.subscriptionId === subscriptionId) {
        this.subscriptionId = undefined
        this.projectionVersion = undefined
      }
      this.confirm()
      await this.serial.run(async () => { this.capture = undefined })
    }
  }

  /** A call may arrive before the stream delivered `subscribed`; wait for it, bounded. */
  private async awaitSubscription(): Promise<void> {
    if (this.closed) throw new Error('The DSH sync relay is closing')
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([this.confirmed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The DSH sync subscription was not confirmed')), this.options.confirmTimeoutMs)
      })])
    } finally { clearTimeout(timer) }
    if (this.closed) throw new Error('The DSH sync relay is closing')
  }

  private requireSubscription(subscriptionId: string): void {
    if (this.closed || subscriptionId !== this.subscriptionId || this.projectionVersion === undefined) {
      // Not acknowledged: the plugin saves checkpoints only after an acknowledgement.
      throw new Bridge2Error(SUBSCRIPTION_UNKNOWN, 'The Connector no longer runs this sync subscription')
    }
  }

  /** Apply one batch; resolving is the plugin's acknowledgement. */
  async ingestBatch(batch: SyncBatch): Promise<void> {
    if (batch.subscriptionId === this.subscriptionId) await this.awaitSubscription()
    await this.serial.run(async () => {
      this.requireSubscription(batch.subscriptionId)
      // A redelivery whose acknowledgement was lost: already applied, acknowledge again.
      if (batch.batchSeq === this.expectedBatch - 1) return
      if (batch.batchSeq !== this.expectedBatch) throw new Error('Out-of-order event batch; resubscribe to recalibrate')
      if (batch.projectionVersion !== this.projectionVersion) throw new Error('Invalid DSH event batch')
      const notices: Notification[] = []
      for (const operation of batch.operations) {
        if (operation.kind === 'workspace.inventory') continue // older plugins; grouping uses the session cwd
        if (operation.kind !== 'notifications' || !Array.isArray(operation.notifications)) {
          throw new Error(`Unsupported bridge operation: ${String(operation.kind)}`)
        }
        for (const raw of operation.notifications) {
          const notice = this.unquarantined(notification(raw))
          if (notice) notices.push(notice)
        }
      }
      const started = this.options.now()
      if (notices.length) await this.ledger.publish(notices)
      this.expectedBatch += 1
      if (notices.some(notice => notice.method === 'session.inventory.complete' && notice.params.complete === true)) this.options.onBaseline?.()
      const drafts = notices.length > 0 && notices.every(isStreamingDraft)
      const streaming = drafts && this.lastDraftPost !== undefined
      this.lastDraftPost = drafts ? started : undefined
      if (streaming) {
        const hold = started + this.options.streamingIntervalMs - this.options.now()
        if (hold > 0) await this.options.sleep(hold)
      }
    })
  }

  /** sync.py `unquarantined`: drop or rewrite a notification that would contradict a quarantine. */
  private unquarantined(notice: Notification): Notification | undefined {
    if (!this.quarantined.size) return notice
    const { method, params } = notice
    const record = typeof params.sessionId === 'string' ? this.quarantined.get(params.sessionId) : undefined
    if (record) {
      if (QUARANTINED_HISTORY.has(method)) { record.stale = true; return undefined }
      if (method === 'session.source.updated' && params.availability === 'available') return undefined
      const source = params.sourceState as Json | undefined
      if (method === 'session.meta.upsert' && source?.availability === 'available') {
        return { method, params: { ...params, sourceState: this.sourceState(record) } }
      }
    }
    if (method === 'session.inventory.complete' && Array.isArray(params.sessions)) {
      const sessions = (params.sessions as unknown[]).map(entry => {
        const id = typeof entry === 'object' && entry !== null ? (entry as Json).sessionId : undefined
        const quarantined = typeof id === 'string' ? this.quarantined.get(id) : undefined
        return quarantined ? { ...(entry as Json), sourceState: this.sourceState(quarantined) } : entry
      })
      return { method, params: { ...params, sessions } }
    }
    return notice
  }

  private sourceState(record: Quarantine): Json {
    return { availability: 'unavailable', reason: record.reason, observedAt: new Date(this.options.now()).toISOString(), observationOrigin: 'event' }
  }

  async loadCheckpoint(subscriptionId: string, externalSessionId: string): Promise<Checkpoint | null> {
    if (subscriptionId === this.subscriptionId) await this.awaitSubscription()
    return this.serial.run(async () => {
      this.requireSubscription(subscriptionId)
      if (!this.durableCheckpoints) return null
      return parseCheckpoint(await this.ledger.readState(checkpointKey(externalSessionId)))
    })
  }

  /**
   * Everything a checkpoint covers was acknowledged, so it is committed locally already:
   * storing it says "the plugin may resume after this point".
   */
  async saveCheckpoint(subscriptionId: string, externalSessionId: string, checkpoint: unknown): Promise<void> {
    if (subscriptionId === this.subscriptionId) await this.awaitSubscription()
    await this.serial.run(async () => {
      this.requireSubscription(subscriptionId)
      if (!this.durableCheckpoints) return
      const value = parseCheckpoint(checkpoint)
      if (!value) throw new Error('Invalid DSH checkpoint')
      // The plugin believes its capture was ingested; it was quarantined instead.
      if ([...this.quarantined.values()].some(record => record.externalSessionId === externalSessionId)) return
      await this.ledger.writeState(checkpointKey(externalSessionId), { ...value })
    })
  }

  async deleteCheckpoint(subscriptionId: string, externalSessionId: string): Promise<void> {
    if (subscriptionId === this.subscriptionId) await this.awaitSubscription()
    await this.serial.run(async () => {
      this.requireSubscription(subscriptionId)
      await this.ledger.deleteState(checkpointKey(externalSessionId))
    })
  }

  /** Assemble a paged capture; resolving means it was committed or quarantined. */
  async ingestSnapshot(request: SnapshotRequest, pages: AsyncIterable<SnapshotPage>): Promise<SnapshotResult> {
    await this.serial.run(async () => {
      this.requireSubscription(request.subscriptionId)
      const record = this.quarantined.get(request.sessionId)
      this.capture = { captureId: request.captureId, sessionId: request.sessionId, meta: request.meta, throughSeq: request.throughSeq,
        items: [], ids: new Set(),
        // Before the retry is due, a capture would only be refused again: keep the quarantine.
        withheld: record !== undefined && this.options.now() < record.retryAt }
    })
    try {
      for await (const page of pages) {
        await this.serial.run(async () => {
          const capture = this.capture
          if (!capture) throw new Error('Snapshot page outside a capture')
          if (page.captureId !== capture.captureId) throw new Error('Snapshot page belongs to a different capture')
          if (capture.withheld) return
          for (const item of page.items) {
            const id = item.id
            if (item.sessionId !== capture.sessionId || typeof id !== 'string' || capture.ids.has(id)) throw new Error('Invalid snapshot item identity')
            capture.ids.add(id)
            capture.items.push(item)
          }
        })
      }
      return await this.serial.run(async () => {
        const capture = this.capture
        if (!capture) throw new Error('Snapshot commit outside a capture')
        if (capture.captureId !== request.captureId) throw new Error('Snapshot commit belongs to a different capture')
        this.capture = undefined
        if (!capture.withheld) await this.deliver(capture)
        const record = this.quarantined.get(capture.sessionId)
        return record ? { accepted: false, quarantined: true, reason: record.reason } : { accepted: true }
      })
    } catch (error) {
      // A stale stream must not clear the capture its replacement started.
      await this.serial.run(async () => { if (this.capture?.captureId === request.captureId) this.capture = undefined })
      throw error
    }
  }

  private async deliver(capture: Capture): Promise<void> {
    const external = typeof capture.meta.externalSessionId === 'string' ? capture.meta.externalSessionId : null
    try {
      await this.ledger.replaceSession(capture.sessionId, capture.meta, withEventTime(capture.items, capture.meta.lastActivityAt))
    } catch (error) {
      if (!(error instanceof HistoryRefusedError)) throw error
      await this.quarantine(capture.sessionId, external, error.reason)
      return
    }
    await this.release(capture.sessionId, capture.meta)
  }

  private async quarantine(sessionId: string, externalSessionId: string | null, reason: Quarantine['reason']): Promise<void> {
    const attempts = (this.quarantined.get(sessionId)?.attempts ?? 0) + 1
    const delay = Math.min(this.retryBase(reason) * 2 ** (attempts - 1), QUARANTINE_MAX_RETRY_MS)
    const record: Quarantine = { externalSessionId, reason, attempts, retryAt: this.options.now() + delay, stale: false }
    this.quarantined.set(sessionId, record)
    // Captures are withheld until the retry, so it must exist even if the report below fails.
    const retry = this.retryCapture(sessionId, record, delay).finally(() => this.retries.delete(retry))
    this.retries.add(retry)
    await this.ledger.publish([{ method: 'session.source.updated', params: { sessionId, externalSessionId, ...this.sourceState(record) } }])
  }

  private retryBase(reason: Quarantine['reason']): number {
    return reason === 'history_too_large' ? this.options.tooLargeRetryMs : this.options.retryMs
  }

  /** Ask the plugin for a fresh complete capture of a quarantined session once it is due. */
  private async retryCapture(sessionId: string, record: Quarantine, delay: number): Promise<void> {
    let attempts = record.attempts
    for (;;) {
      await this.options.sleep(Math.max(delay, 0), this.abort.signal)
      if (this.closed || this.quarantined.get(sessionId) !== record) return // released, or a newer refusal owns the retry
      try {
        await this.calls.request('refreshSync', { sessionId, externalSessionId: record.externalSessionId })
        return
      } catch (error) {
        this.options.onError?.('sync.quarantine_refresh_failed', error)
        attempts += 1
        delay = Math.min(this.retryBase(record.reason) * 2 ** (attempts - 1), QUARANTINE_MAX_RETRY_MS)
      }
    }
  }

  private async release(sessionId: string, meta: Json): Promise<void> {
    if (!this.quarantined.delete(sessionId)) return
    const declared = meta.sourceState as Json | undefined
    const source = declared?.availability === 'available' ? declared : { availability: 'available' }
    // The capture's own source fact may predate the "unavailable" published meanwhile; restate it as of now.
    await this.ledger.publish([{ method: 'session.source.updated', params: { sessionId, externalSessionId: meta.externalSessionId ?? null,
      ...source, observedAt: new Date(this.options.now()).toISOString(), observationOrigin: 'event' } }])
  }

  async close(): Promise<void> {
    this.abort.abort()
    this.confirm()
    await Promise.allSettled([...this.retries])
  }
}
