import type { BridgeLogEntry, BridgeLogSnapshot, ConnectorLogPage, RuntimeLogEntry, RuntimeLogLevel, RuntimeLogPage, RuntimeLogQuery, RuntimeLogSource } from '../../contracts/logs.js'
import type { LogEntry, LogPage, LogsServiceClient } from '../generated/connector-logs.js'
import { record } from './types.js'

function resolveEntrySource(entry: LogEntry): RuntimeLogSource {
  const rawSource = entry.source as string
  if (rawSource === 'plugin' || entry.name === 'dsh-plugin' || entry.name.startsWith('dsh-plugin.')) {
    return 'plugin'
  }
  if (rawSource === 'connector') {
    return 'connector'
  }
  if (rawSource === 'bridge' || entry.name === 'dsh-bridge' || entry.name.startsWith('dsh-bridge.')) {
    return 'bridge'
  }
  return 'connector'
}

function parseStructuredEntry(entry: LogEntry): {
  level: RuntimeLogLevel
  method: string
  outcome: 'success' | 'failure' | 'pending' | 'info'
  details: string | null
} {
  const event = entry.message
  const eventName = event.match(/^[A-Za-z][\w.-]*/)?.[0] ?? event
  let parsed: Record<string, unknown> | undefined
  if (entry.details) {
    try { parsed = record(JSON.parse(entry.details)) } catch { /* unstructured details */ }
  }
  const tail = event.slice(eventName.length).trim()
  if (tail.startsWith('{')) {
    try { parsed = { ...(parsed ?? {}), ...record(JSON.parse(tail)) } } catch { /* unstructured message */ }
  }
  const rawLevel = entry.level.toLowerCase()
  const level: RuntimeLogLevel = rawLevel === 'warning' || rawLevel === 'warn' ? 'warn'
    : rawLevel === 'error' || rawLevel === 'critical' ? 'error'
    : rawLevel === 'debug' || rawLevel === 'trace' ? 'debug'
    : 'info'
  const method = typeof parsed?.method === 'string' ? parsed.method : eventName.replace(/\.(started|completed|failed)$/, '')
  const outcome = level === 'error' || eventName.endsWith('.failed') || eventName.endsWith('_failed') || eventName === 'rpc.rejected' ? 'failure'
    : eventName.endsWith('.started') ? 'pending'
    : eventName.endsWith('.completed') || eventName === 'bridge.listening' || eventName === 'bridge.connected' ? 'success'
    : 'info'
  const details = parsed && Object.keys(parsed).length > 0
    ? JSON.stringify(parsed, null, 2)
    : entry.details && entry.details !== '{}' ? entry.details : null
  return { level, method, outcome, details }
}

/** Adapt the central service to the existing plugin UI contract. No local file reads. */
export function readBridgeLogs(page: LogPage): BridgeLogSnapshot {
  const entries: BridgeLogEntry[] = page.items.map(entry => {
    const parsed = parseStructuredEntry(entry)
    return {
      id: String(entry.seq),
      time: entry.time,
      method: parsed.method,
      outcome: parsed.outcome,
      level: parsed.level,
      event: entry.message,
      details: parsed.details ?? '{}',
    }
  })
  return { entries, updatedAt: new Date().toISOString() }
}

export function toRuntimeLogPage(page: LogPage, available = true, logsPath: string | null = null): RuntimeLogPage {
  const items: RuntimeLogEntry[] = page.items.map(entry => {
    const parsed = parseStructuredEntry(entry)
    return {
      seq: entry.seq,
      time: entry.time,
      source: resolveEntrySource(entry),
      level: parsed.level,
      name: entry.name,
      message: entry.message,
      details: parsed.details,
      exception: entry.exception ?? null,
      method: parsed.method,
      outcome: parsed.outcome,
    }
  })
  return {
    available,
    items,
    firstSeq: page.firstSeq ?? null,
    lastSeq: page.lastSeq ?? null,
    total: page.total,
    hasMoreBefore: page.hasMoreBefore,
    hasMoreAfter: page.hasMoreAfter,
    logsPath,
    updatedAt: new Date().toISOString(),
  }
}

export function validateRuntimeLogQuery(query?: RuntimeLogQuery): {
  source: RuntimeLogSource | null
  beforeSeq: number | null
  afterSeq: number | null
  limit: number
} {
  const source = query?.source === 'plugin' || query?.source === 'bridge' || query?.source === 'connector'
    ? query.source
    : null
  const beforeSeq = typeof query?.beforeSeq === 'number' && Number.isSafeInteger(query.beforeSeq) && query.beforeSeq > 0
    ? query.beforeSeq
    : null
  const afterSeq = typeof query?.afterSeq === 'number' && Number.isSafeInteger(query.afterSeq) && query.afterSeq >= 0
    ? query.afterSeq
    : null
  const limit = typeof query?.limit === 'number' && Number.isSafeInteger(query.limit)
    ? Math.max(1, Math.min(500, query.limit))
    : 200
  return { source, beforeSeq, afterSeq, limit }
}

export async function readRuntimeLogPage(
  client: LogsServiceClient,
  query?: RuntimeLogQuery,
  logsPath: string | null = null,
): Promise<RuntimeLogPage> {
  const normalized = validateRuntimeLogQuery(query)
  if (normalized.source === null || normalized.source === 'connector') {
    const page = await client.read(
      normalized.source,
      normalized.beforeSeq,
      normalized.afterSeq,
      normalized.limit,
      { timeoutMs: 3_000 },
    )
    return toRuntimeLogPage(page, true, logsPath)
  }
  const collected: RuntimeLogEntry[] = []
  const forward = normalized.afterSeq !== null
  let beforeSeq = forward ? null : normalized.beforeSeq
  let afterSeq = forward ? normalized.afterSeq : null
  let hasMoreBefore = false
  let hasMoreAfter = false
  let rawFirstSeq: number | null = null
  let rawLastSeq: number | null = null
  for (let step = 0; step < 5; step++) {
    const page = await client.read('bridge', beforeSeq, afterSeq, normalized.limit, { timeoutMs: 3_000 })
    const mapped = toRuntimeLogPage(page, true, logsPath)
    const matching = mapped.items.filter(item => item.source === normalized.source)
    if (step === 0) {
      hasMoreBefore = page.hasMoreBefore
      hasMoreAfter = page.hasMoreAfter
      rawFirstSeq = page.firstSeq ?? null
      rawLastSeq = page.lastSeq ?? null
    }
    if (forward) {
      collected.push(...matching)
      hasMoreAfter = page.hasMoreAfter
      rawLastSeq = page.lastSeq ?? rawLastSeq
      if (collected.length >= normalized.limit || !page.hasMoreAfter || page.lastSeq === null) break
      afterSeq = page.lastSeq
    } else {
      collected.unshift(...matching)
      hasMoreBefore = page.hasMoreBefore
      rawFirstSeq = page.firstSeq ?? rawFirstSeq
      if (collected.length >= normalized.limit || !page.hasMoreBefore || page.firstSeq === null) break
      beforeSeq = page.firstSeq
    }
  }
  let items = collected
  if (items.length > normalized.limit) {
    if (forward) {
      items = items.slice(0, normalized.limit)
      hasMoreAfter = true
    } else {
      items = items.slice(items.length - normalized.limit)
      hasMoreBefore = true
    }
  }
  return {
    available: true,
    items,
    firstSeq: items[0]?.seq ?? rawFirstSeq,
    lastSeq: items[items.length - 1]?.seq ?? rawLastSeq,
    total: items.length,
    hasMoreBefore,
    hasMoreAfter,
    logsPath,
    updatedAt: new Date().toISOString(),
  }
}

export function readConnectorRuntimeLogs(page: LogPage): ConnectorLogPage {
  return { entries: page.items.map(entry => ({ id: entry.seq, time: entry.time,
    text: `${entry.level} | ${entry.name} | ${entry.message}${entry.exception ? '\n' + entry.exception : ''}` })),
    hasMore: page.hasMoreBefore, oldestId: page.firstSeq ?? null, newestId: page.lastSeq ?? null }
}

