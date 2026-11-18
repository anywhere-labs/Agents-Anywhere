import type { UsageCounter, UsageReportOut } from '../generated/device-meshcall/v1_0/usage-report-out.js'
import type { Clock, IdSource, OutboxStore, UsageFact, UsageSink } from './ports/index.js'

/** device-meshcall 1.0 `UsageCounter.value` and `UsageReportOut.counters` limits. */
export const MAX_COUNTER_VALUE = 10_000
export const MAX_REPORT_COUNTERS = 1_000
export const DEFAULT_USAGE_INTERVAL_MS = 60_000

export interface UsageMeterOptions {
  readonly outbox: Pick<OutboxStore, 'append'>
  readonly clock: Clock
  readonly ids: IdSource
  /** A report was appended (wakes the outbox stream). */
  readonly onReport?: () => void
  readonly onError?: (error: unknown) => void
  /** Period of the timed report; `start` arms it. */
  readonly intervalMs?: number
}

interface Tally {
  readonly counter: UsageCounter
  value: number
  readonly durationsMs: number[]
}

/**
 * Aggregates platform activity into `usage.report` counters, one per (activity, session, Runtime, outcome), and
 * appends a report to the outbox every period, when asked (a turn ended) and when a UTC hour starts, so the
 * Server's hourly statistics place every count in its hour. Counts live in memory until reported.
 */
export class UsageMeter implements UsageSink {
  private tallies = new Map<string, Tally>()
  private firstAt: string | null = null
  private lastAt: string | null = null
  private tail: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null

  public constructor(private readonly options: UsageMeterOptions) {}

  public count(fact: UsageFact): void {
    const at = this.options.clock.nowIso()
    if (this.firstAt !== null && hourOf(at) !== hourOf(this.firstAt)) void this.flush()
    const key = JSON.stringify([fact.name, fact.sessionId, fact.runtimeType, fact.runtimeId, fact.outcome ?? null])
    let tally = this.tallies.get(key)
    if (tally === undefined) {
      tally = {
        counter: {
          name: fact.name,
          value: 0,
          sessionId: fact.sessionId,
          runtimeType: fact.runtimeType,
          runtimeId: fact.runtimeId,
          ...(fact.outcome !== undefined ? { outcome: fact.outcome } : {}),
        },
        value: 0,
        durationsMs: [],
      }
      this.tallies.set(key, tally)
    }
    tally.value += 1
    if (typeof fact.durationMs === 'number' && Number.isFinite(fact.durationMs) && fact.durationMs >= 0) tally.durationsMs.push(Math.round(fact.durationMs))
    this.firstAt ??= at
    this.lastAt = at
    if (tally.value >= MAX_COUNTER_VALUE || this.tallies.size >= MAX_REPORT_COUNTERS) void this.flush()
  }

  /** Cuts the counts so far into a report (synchronously) and appends it after the reports before it. */
  public flush(): Promise<void> {
    const report = this.cut()
    if (report !== null) {
      this.tail = this.tail.then(async () => {
        try {
          await this.options.outbox.append('usage.report', null, report, report.periodEnd)
          this.options.onReport?.()
        } catch (error) {
          this.options.onError?.(error)
        }
      })
    }
    return this.tail
  }

  public start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => void this.flush(), this.options.intervalMs ?? DEFAULT_USAGE_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Stops the timer and reports what is left. */
  public async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    await this.flush()
  }

  private cut(): UsageReportOut | null {
    if (this.tallies.size === 0 || this.firstAt === null || this.lastAt === null) return null
    const now = this.options.clock.nowIso()
    // A report belongs to its end's hour: when that hour already passed, it ends at its last count.
    const periodEnd = hourOf(now) === hourOf(this.firstAt) ? now : this.lastAt
    const counters = [...this.tallies.values()].map(tally => ({
      ...tally.counter,
      value: tally.value,
      ...(tally.durationsMs.length > 0 ? { durationsMs: tally.durationsMs } : {}),
    }))
    const report: UsageReportOut = { reportId: this.options.ids.newId('usage_'), periodStart: this.firstAt, periodEnd, counters }
    this.tallies = new Map()
    this.firstAt = null
    this.lastAt = null
    return report
  }
}

/** The UTC hour of an ISO 8601 UTC timestamp (`YYYY-MM-DDTHH`). */
function hourOf(iso: string): string {
  return iso.slice(0, 13)
}
