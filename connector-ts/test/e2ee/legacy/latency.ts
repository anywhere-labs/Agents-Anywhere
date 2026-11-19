import { randomBytes } from 'node:crypto'
import { ClientSecureChannel } from './client-channel.js'
import { inputDigest } from '../../../src/channel/formats.js'

export interface Summary {
  readonly n: number
  readonly p50: number
  readonly p95: number
  readonly max: number
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]!
}

export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b)
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? Number.NaN }
}

export interface Comparison {
  readonly plainP95: number
  readonly encryptedP95: number
  /** encrypted / plain - 1 */
  readonly increase: number
  readonly pass: boolean
}

export function compareP95(plain: Summary, encrypted: Summary, limit = 0.2): Comparison {
  const increase = encrypted.p95 / plain.p95 - 1
  return { plainP95: plain.p95, encryptedP95: encrypted.p95, increase, pass: Number.isFinite(increase) && increase <= limit }
}

// ---------------------------------------------------------------------------
// One content path (plain or encrypted)
// ---------------------------------------------------------------------------

export type SessionEvent = Record<string, unknown>

/** The operations needed to open a session; plain mode and encrypted mode each implement them. */
export interface ContentPath {
  snapshot(sessionId: string): Promise<unknown>
  sendMessage(sessionId: string, content: string): Promise<void>
  subscribe(sessionId: string, onEvent: (event: SessionEvent) => void): Promise<() => Promise<void>>
  close(): Promise<void>
}

export async function measureFirstScreen(
  open: () => Promise<ContentPath>,
  sessionId: string,
  iterations: number,
  mode: 'warm' | 'cold',
  clock: () => number = () => performance.now(),
): Promise<Summary> {
  const timings: number[] = []
  if (mode === 'warm') {
    const path = await open()
    try {
      await path.snapshot(sessionId) // warm-up
      for (let i = 0; i < iterations; i++) {
        const started = clock()
        await path.snapshot(sessionId)
        timings.push(clock() - started)
      }
    } finally {
      await path.close()
    }
    return summarize(timings)
  }
  for (let i = 0; i < iterations; i++) {
    const started = clock()
    const path = await open()
    try {
      await path.snapshot(sessionId)
      timings.push(clock() - started)
    } finally {
      await path.close()
    }
  }
  return summarize(timings)
}

export interface StreamOptions {
  readonly message: string
  readonly timeoutMs: number
  /** Device time field in the event (ISO string or milliseconds); defaults to `emittedAt`. */
  readonly timeField?: string
  /** Receiving this event ends the round (default: `runtime.state.updated` with the payload status back to idle). */
  readonly done?: (event: SessionEvent) => boolean
  readonly now?: () => number
}

function eventTime(event: SessionEvent, field: string): number | null {
  const value = event[field]
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function turnFinished(event: SessionEvent): boolean {
  if (event['type'] !== 'runtime.state.updated') return false
  const payload = event['payload'] as Record<string, unknown> | undefined
  const state = (payload?.['state'] ?? payload?.['runtimeState'] ?? payload) as Record<string, unknown> | undefined
  const status = state?.['status'] ?? state?.['phase']
  return status === 'idle' || status === 'completed'
}

/** One round: subscribe, send a message, collect events until the round ends or times out; returns each event's latency in milliseconds. */
export async function measureStreaming(path: ContentPath, sessionId: string, options: StreamOptions): Promise<number[]> {
  const field = options.timeField ?? 'emittedAt'
  const now = options.now ?? Date.now
  const done = options.done ?? turnFinished
  const lags: number[] = []
  let sent = false
  let finish!: () => void
  const finished = new Promise<void>((resolve) => (finish = resolve))
  const unsubscribe = await path.subscribe(sessionId, (event) => {
    if (!sent) return // backlog from before the subscription (session.subscribed, replays) is not counted
    const at = eventTime(event, field)
    if (at !== null) lags.push(now() - at)
    if (done(event)) finish()
  })
  try {
    sent = true
    await path.sendMessage(sessionId, options.message)
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, options.timeoutMs))])
  } finally {
    await unsubscribe()
  }
  return lags
}

// ---------------------------------------------------------------------------
// Plain mode: HTTP + session WebSocket
// ---------------------------------------------------------------------------

export interface Endpoint {
  readonly serverUrl: string
  readonly accessToken: string
}

export interface ChannelFactory {
  (ch: string): Promise<{ channel: ClientSecureChannel; close(): Promise<void> }>
}

export function encryptedPath(
  factory: ChannelFactory,
  options: { readonly deviceId: string; readonly directoryKey: Uint8Array; readonly register?: (commandId: string, digest: string) => Promise<void> },
): () => Promise<ContentPath> {
  return async () => {
    const opened = await factory(`e7${randomBytes(6).toString('hex')}`)
    const { channel } = opened
    const subscriptions: string[] = []
    return {
      async snapshot(sessionId) {
        const response = await channel.request('GET', `/api/v2/sessions/${sessionId}/snapshot`)
        if (response.status >= 400) throw new Error(`snapshot through the channel: ${response.status}`)
        return response.body
      },
      async sendMessage(sessionId, content) {
        const clientMessageId = `e7_${randomBytes(6).toString('hex')}`
        const body = { content, clientMessageId }
        await options.register?.(clientMessageId, inputDigest(options.directoryKey, new TextEncoder().encode(JSON.stringify(body))))
        const response = await channel.request('POST', `/api/v2/sessions/${sessionId}/runtime/messages`, body)
        if (response.status >= 400) throw new Error(`send through the channel: ${response.status}`)
      },
      async subscribe(sessionId, onEvent) {
        const id = await channel.subscribe(sessionId, null, onEvent)
        subscriptions.push(id)
        return () => channel.unsubscribe(id)
      },
      close: () => opened.close(),
    }
  }
}

// ---------------------------------------------------------------------------

export interface E7Config {
  readonly iterations?: number
  readonly plain: Endpoint & { readonly sessionId: string }
  readonly encrypted: Endpoint & {
    readonly sessionId: string
    readonly identityFile: string
    /** Used on the first run; later runs read identityFile. */
    readonly pairingUri?: string
    readonly ticketScope?: Record<string, unknown>
  }
  /** When omitted, streaming is not measured. */
  readonly stream?: { readonly message: string; readonly rounds?: number; readonly timeoutMs?: number; readonly timeField?: string }
  /** Allowed P95 increase ratio, default 0.2. */
  readonly limit?: number
}

export interface E7Report {
  readonly at: string
  readonly firstScreen: { plain: Summary; encryptedWarm: Summary; encryptedCold: Summary; verdict: Comparison }
  readonly stream?: { plain: Summary; encrypted: Summary; verdict: Comparison }
  readonly pass: boolean
}

export async function runE7(
  config: E7Config,
  paths: { readonly plain: () => Promise<ContentPath>; readonly encrypted: () => Promise<ContentPath> },
): Promise<E7Report> {
  const iterations = config.iterations ?? 50
  const limit = config.limit ?? 0.2
  const plain = await measureFirstScreen(paths.plain, config.plain.sessionId, iterations, 'warm')
  const encryptedWarm = await measureFirstScreen(paths.encrypted, config.encrypted.sessionId, iterations, 'warm')
  const encryptedCold = await measureFirstScreen(paths.encrypted, config.encrypted.sessionId, Math.max(5, Math.floor(iterations / 5)), 'cold')
  const firstScreen = { plain, encryptedWarm, encryptedCold, verdict: compareP95(plain, encryptedWarm, limit) }
  let stream: E7Report['stream']
  if (config.stream) {
    const lags = { plain: [] as number[], encrypted: [] as number[] }
    const options: StreamOptions = {
      message: config.stream.message,
      timeoutMs: config.stream.timeoutMs ?? 120_000,
      ...(config.stream.timeField ? { timeField: config.stream.timeField } : {}),
    }
    for (let round = 0; round < (config.stream.rounds ?? 3); round++) {
      for (const [mode, open, sessionId] of [
        ['plain', paths.plain, config.plain.sessionId],
        ['encrypted', paths.encrypted, config.encrypted.sessionId],
      ] as const) {
        const path = await open()
        try {
          lags[mode].push(...(await measureStreaming(path, sessionId, options)))
        } finally {
          await path.close()
        }
      }
    }
    const plainStream = summarize(lags.plain)
    const encryptedStream = summarize(lags.encrypted)
    stream = { plain: plainStream, encrypted: encryptedStream, verdict: compareP95(plainStream, encryptedStream, limit) }
  }
  return {
    at: new Date().toISOString(),
    firstScreen,
    ...(stream ? { stream } : {}),
    pass: firstScreen.verdict.pass && (stream?.verdict.pass ?? true),
  }
}

export function formatReport(report: E7Report): string {
  const row = (name: string, s: Summary) => `${name.padEnd(22)} n=${String(s.n).padStart(4)}  p50 ${s.p50.toFixed(1).padStart(8)} ms  p95 ${s.p95.toFixed(1).padStart(8)} ms  max ${s.max.toFixed(1).padStart(8)} ms`
  const verdict = (v: Comparison) => `P95 ${v.increase >= 0 ? '+' : ''}${(v.increase * 100).toFixed(1)}% → ${v.pass ? '通过' : '不通过'}`
  const lines = [
    `E-7 ${report.at}`,
    '首屏',
    row('  普通', report.firstScreen.plain),
    row('  加密（热）', report.firstScreen.encryptedWarm),
    row('  加密（冷，含握手）', report.firstScreen.encryptedCold),
    `  ${verdict(report.firstScreen.verdict)}`,
  ]
  if (report.stream) {
    lines.push('流式（事件 emittedAt → 客户端收到）', row('  普通', report.stream.plain), row('  加密', report.stream.encrypted), `  ${verdict(report.stream.verdict)}`)
  }
  lines.push(report.pass ? '结论：通过' : '结论：不通过')
  return lines.join('\n')
}
