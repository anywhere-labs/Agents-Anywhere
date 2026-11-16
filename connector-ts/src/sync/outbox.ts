import type { OutboxRecord, OutboxStore } from '../application/ports/index.js'
import type { SummaryFacts } from '../domain/conversation/index.js'
import type { OutboxItem } from '../generated/device-meshcall/v1_0/outbox-item.js'
import { wireSummary, type DisplaySealer } from './display.js'

/**
 * Turns a stored outbox record into its wire item. Summaries are sealed at send time, so a directory key
 * rotation only needs a re-send, not a rewrite of the outbox.
 */
export function outboxItem(record: OutboxRecord, sealer: DisplaySealer): OutboxItem {
  if (record.kind === 'session.summary') {
    return { oid: record.oid, m: record.kind, p: { summary: wireSummary(record.payload.summary as SummaryFacts, sealer) } }
  }
  if (record.kind === 'session.inventory' && Array.isArray(record.payload.sessions)) {
    return { oid: record.oid, m: record.kind, p: { ...record.payload, sessions: (record.payload.sessions as SummaryFacts[]).map(facts => wireSummary(facts, sealer)) } }
  }
  return { oid: record.oid, m: record.kind, p: record.payload }
}

/** Wakes outbox streams when something was appended (commits, command receipts). */
export class OutboxSignal {
  private readonly waiters = new Set<() => void>()

  public poke(): void {
    for (const waiter of [...this.waiters]) waiter()
  }

  public wait(signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        this.waiters.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      this.waiters.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }
}

export interface OutboxStreamOptions {
  readonly outbox: OutboxStore
  readonly sealer: DisplaySealer
  readonly signal: OutboxSignal
  /** Poll interval when nothing poked (appends from paths that do not poke). */
  readonly pollMs?: number
  readonly batch?: number
}

/**
 * `Link/outbox` (06-protocols.md §2.4): every open starts again from the lowest unacknowledged oid and sends in
 * oid order; `Link/ackOutbox` deletes cumulatively. Delivery is at-least-once; the Server is idempotent by
 * natural keys.
 */
export async function* outboxStream(options: OutboxStreamOptions, abort: AbortSignal): AsyncGenerator<OutboxItem> {
  let sent = 0
  while (!abort.aborted) {
    const records = await options.outbox.pending(sent, options.batch ?? 100)
    if (records.length === 0) {
      await options.signal.wait(abort, options.pollMs ?? 1000)
      continue
    }
    for (const record of records) {
      if (abort.aborted) return
      yield outboxItem(record, options.sealer)
      sent = record.oid
    }
  }
}
