// The Connector's runtime log journal, the format and retention of v2 connector/core/runtime_logs.py: rotating
// JSONL segments (`runtime-<seq>.jsonl`, one JSON array per batch), `state.json` holding the next sequence, at
// most 10,000 records / 32 MiB / 7 days, `(producer, eventId)` deduplication, fsync before acknowledging a
// durable batch, a torn tail truncated on load. Records are redacted before they are written.
//
// v3 keeps its journal under its own data directory (`~/.agents-anywhere/v3/logs`); v2's `logs/` stays where it
// is (04-connector.md §6.2). Only the process holding the runtime lease writes, so the file lock v2 needed for
// several RPC hosts is replaced by serialising inside this process.
import { randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, rm, truncate } from 'node:fs/promises'
import { join } from 'node:path'

import { redact } from './redact.js'

export type LogSource = 'connector' | 'bridge'

export interface LogRecord {
  time: string
  level: string
  name: string
  message: string
  exception?: string | null
  details?: string | null
}

export interface LogWrite extends LogRecord {
  producer: string
  eventId: string
}

export interface LogEntry extends LogRecord {
  seq: number
  source: LogSource
  gapBefore?: boolean
}

export interface LogPage {
  items: LogEntry[]
  firstSeq: number | null
  lastSeq: number | null
  total: number
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

interface Row {
  seq: number
  received: number
  size: number
  source: LogSource
  record: LogRecord
  producer: string | null
  eventId: string | null
}

interface Segment {
  path: string | null
  rows: Row[]
}

export interface LogPolicy {
  maxRows?: number
  maxBytes?: number
  maxAgeMs?: number
  now?: () => number
}

const FIELD_LIMITS: Record<keyof LogRecord, number> = { time: 80, level: 20, name: 200, message: 16_000, exception: 16_000, details: 16_000 }

/** Bounds and redacts one record (v2 `LogRecord` limits). */
export function cleanRecord(record: LogRecord): LogRecord {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(FIELD_LIMITS) as (keyof LogRecord)[]) {
    const value = record[key]
    if (value === undefined) continue
    out[key] = typeof value === 'string' ? redact(value).slice(0, FIELD_LIMITS[key]) : value
  }
  return out as unknown as LogRecord
}

export class LogStore {
  private segments: Segment[] = []
  private sequence = 0
  private seen = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  private waiters = new Set<() => void>()
  private closed = false
  private readonly maxRows: number
  private readonly maxBytes: number
  private readonly maxAgeMs: number
  private readonly now: () => number

  private constructor(private readonly dir: string | null, policy: LogPolicy) {
    this.maxRows = policy.maxRows ?? 10_000
    this.maxBytes = policy.maxBytes ?? 32 * 1024 * 1024
    this.maxAgeMs = policy.maxAgeMs ?? 7 * 86_400_000
    this.now = policy.now ?? Date.now
  }

  /**
   * Opens the journal in `dir`, or keeps logs in memory when `dir` is null or unusable: logging must never
   * stop the Connector from serving sessions.
   */
  public static async open(dir: string | null, policy: LogPolicy = {}): Promise<LogStore> {
    if (dir !== null) {
      try {
        const store = new LogStore(dir, policy)
        await store.load()
        return store
      } catch {
        // Fall through to memory.
      }
    }
    return new LogStore(null, policy)
  }

  public get persistent(): boolean {
    return this.dir !== null
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => {
      if (this.closed) throw new Error('Runtime log store is closed')
      return work()
    })
    this.chain = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<void> {
    const dir = this.dir!
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    let recovered = false
    try {
      const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { seq?: unknown }
      if (typeof state.seq !== 'number' || !Number.isInteger(state.seq)) throw new TypeError('invalid state')
      this.sequence = state.seq
    } catch (error) {
      // Missing is a fresh journal; damaged is recovered from the segments that survive.
      recovered = (error as NodeJS.ErrnoException).code !== 'ENOENT'
      this.sequence = 0
    }
    for (const name of (await readdir(dir)).filter(n => /^runtime-\d+\.jsonl$/u.test(n)).sort()) {
      const path = join(dir, name)
      const bytes = await readFile(path)
      const rows: Row[] = []
      let validEnd = 0
      let offset = 0
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset)
        if (newline < 0) break
        try {
          const batch = JSON.parse(bytes.subarray(offset, newline).toString('utf8')) as unknown
          if (!Array.isArray(batch) || batch.some(row => row === null || typeof row !== 'object' || !Number.isInteger((row as Row).seq))) throw new TypeError('invalid batch')
          rows.push(...(batch as Row[]))
          validEnd = newline + 1
          offset = newline + 1
        } catch {
          break
        }
      }
      // A torn tail or damaged middle: keep every batch before the damage.
      if (validEnd < bytes.length) await truncate(path, validEnd)
      if (rows.length > 0) {
        this.sequence = Math.max(this.sequence, rows[rows.length - 1]!.seq)
        this.segments.push({ path, rows })
      } else await rm(path, { force: true })
    }
    this.index()
    if (recovered) await this.saveState(true)
    await this.prune(true)
  }

  private index(): void {
    this.seen = new Set(this.segments.flatMap(segment => segment.rows.filter(row => row.producer !== null && row.producer !== undefined).map(row => `${row.producer}\0${row.eventId}`)))
  }

  private async saveState(durable: boolean): Promise<void> {
    if (this.dir === null) return
    const temporary = join(this.dir, `state.${randomUUID()}.tmp`)
    const file = await open(temporary, 'w', 0o600)
    try {
      await file.writeFile(JSON.stringify({ seq: this.sequence, version: randomUUID().replace(/-/gu, '') }))
      if (durable) await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, join(this.dir, 'state.json'))
  }

  private async prune(durable: boolean): Promise<void> {
    const cutoff = this.now() - this.maxAgeMs
    let count = this.segments.reduce((n, s) => n + s.rows.length, 0)
    let size = this.segments.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.size, 0), 0)
    let changed = false
    while (this.segments.length > 0) {
      const first = this.segments[0]!
      if (count <= this.maxRows && size <= this.maxBytes && first.rows[first.rows.length - 1]!.received * 1000 >= cutoff) break
      if (!changed) await this.saveState(durable)
      if (first.path !== null) await rm(first.path, { force: true })
      this.segments.shift()
      count -= first.rows.length
      size -= first.rows.reduce((m, r) => m + r.size, 0)
      changed = true
    }
    if (changed) this.index()
  }

  /**
   * Appends records; returns how many were new (a repeated `(producer, eventId)` is skipped). `durable: false`
   * (the Connector's own records, acknowledged to nobody) skips fsync.
   */
  public append(records: readonly (LogRecord & { producer?: string; eventId?: string })[], source: LogSource, durable = true): Promise<number> {
    return this.serial(async () => {
      await this.prune(durable)
      const seen = new Set(this.seen)
      const batch: Row[] = []
      for (const record of records) {
        const producer = record.producer ?? null
        const eventId = record.eventId ?? null
        const key = `${producer}\0${eventId}`
        if (producer !== null && seen.has(key)) continue
        seen.add(key)
        const row: Row = { source, record: cleanRecord(record), producer, eventId, seq: this.sequence + batch.length + 1, received: this.now() / 1000, size: 0 }
        row.size = Buffer.byteLength(JSON.stringify(row), 'utf8')
        batch.push(row)
      }
      if (batch.length === 0) return 0
      this.sequence = batch[batch.length - 1]!.seq
      // Reserve the sequence before appending, so a failure never reuses cursors.
      await this.saveState(durable)
      const encoded = `${JSON.stringify(batch)}\n`
      const segmentLimit = Math.min(2 * 1024 * 1024, this.maxBytes)
      const last = this.segments[this.segments.length - 1]
      if (last === undefined || last.rows.length + batch.length > Math.min(1000, this.maxRows) || last.rows.reduce((m, r) => m + r.size, 0) + Buffer.byteLength(encoded) > segmentLimit) {
        this.segments.push({ path: this.dir === null ? null : join(this.dir, `runtime-${String(batch[0]!.seq).padStart(20, '0')}.jsonl`), rows: [] })
      }
      const segment = this.segments[this.segments.length - 1]!
      if (segment.path !== null) {
        if (durable) {
          const file = await open(segment.path, 'a', 0o600)
          try {
            await file.write(encoded)
            await file.sync()
          } finally {
            await file.close()
          }
        } else await appendFile(segment.path, encoded, { mode: 0o600 })
      }
      segment.rows.push(...batch)
      this.seen = seen
      await this.prune(durable)
      for (const wake of [...this.waiters]) wake()
      return batch.length
    })
  }

  private rows(): Row[] {
    return this.segments.flatMap(segment => segment.rows)
  }

  /** `read(source?, beforeSeq?, afterSeq?, limit=200)`: an ascending page; the latest one by default. */
  public read(request: { source?: LogSource | null; beforeSeq?: number | null; afterSeq?: number | null; limit?: number } = {}): Promise<LogPage> {
    return this.serial(async () => {
      await this.prune(false)
      const limit = Math.max(1, Math.min(request.limit ?? 200, 1000))
      const rows = this.rows().filter(row => request.source === undefined || request.source === null || row.source === request.source)
      const selected = rows.filter(row => (request.beforeSeq === undefined || request.beforeSeq === null || row.seq < request.beforeSeq) && (request.afterSeq === undefined || request.afterSeq === null || row.seq > request.afterSeq))
      const page = request.afterSeq !== undefined && request.afterSeq !== null ? selected.slice(0, limit) : selected.slice(-limit)
      const items = page.map(row => ({ ...row.record, seq: row.seq, source: row.source }))
      const first = rows[0]?.seq ?? null
      const last = rows[rows.length - 1]?.seq ?? null
      return {
        items,
        firstSeq: first,
        lastSeq: last,
        total: rows.length,
        hasMoreBefore: items.length > 0 && first !== null && first < items[0]!.seq,
        hasMoreAfter: items.length > 0 && last !== null && last > items[items.length - 1]!.seq,
      }
    })
  }

  /** Removes every record; the sequence keeps counting (cursors stay valid). */
  public clear(): Promise<LogPage> {
    return this.serial(async () => {
      await this.saveState(true)
      for (const segment of this.segments) if (segment.path !== null) await rm(segment.path, { force: true })
      this.segments = []
      this.seen.clear()
      await this.saveState(true)
    }).then(() => this.read())
  }

  /** History from `since`, then new records as they come; the first record after a retention gap has `gapBefore`. */
  public async *tail(since: number | null = null, source: LogSource | null = null, signal?: AbortSignal): AsyncGenerator<LogEntry> {
    let cursor = since
    while (!this.closed && signal?.aborted !== true) {
      const page = await this.read({ source, afterSeq: cursor })
      const oldest = this.rows()[0]?.seq ?? null
      for (const [index, item] of page.items.entries()) {
        if (index === 0 && cursor !== null && oldest !== null && cursor < oldest - 1) item.gapBefore = true
        cursor = item.seq
        yield item
      }
      if (page.hasMoreAfter) continue
      if (isAborted(signal)) return
      await new Promise<void>(resolve => {
        const done = (): void => {
          this.waiters.delete(done)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        this.waiters.add(done)
        signal?.addEventListener('abort', done, { once: true })
      })
    }
  }

  public async close(): Promise<void> {
    await this.chain
    this.closed = true
    for (const wake of [...this.waiters]) wake()
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}
