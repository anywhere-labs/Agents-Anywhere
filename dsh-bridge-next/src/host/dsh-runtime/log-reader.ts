import type { BridgeLogEntry, BridgeLogSnapshot, ConnectorLogPage } from '../../contracts/logs.js'
import type { LogPage } from '../generated/connector-logs.js'
import { record } from './types.js'

/** Adapt the central service to the existing plugin UI contract. No local file reads. */
export function readBridgeLogs(page: LogPage): BridgeLogSnapshot {
  const entries: BridgeLogEntry[] = page.items.map(entry => {
    const event = entry.message
    let details: Record<string, unknown> = {}
    try { details = record(JSON.parse(entry.details ?? '{}')) } catch { /* older unstructured record */ }
    const rawLevel = entry.level.toLowerCase()
    const level: BridgeLogEntry['level'] = rawLevel === 'warning' ? 'warn' : ['debug', 'info', 'warn', 'error'].includes(rawLevel) ? rawLevel as BridgeLogEntry['level'] : 'info'
    const method = typeof details.method === 'string' ? details.method : event.replace(/\.(started|completed|failed)$/, '')
    const outcome = level === 'error' || event.endsWith('.failed') || event.endsWith('_failed') || event === 'rpc.rejected' ? 'failure'
      : event.endsWith('.started') ? 'pending' : event.endsWith('.completed') || event === 'bridge.listening' ? 'success' : 'info'
    return { id: String(entry.seq), time: entry.time, method, outcome, level, event, details: JSON.stringify(details, null, 2) }
  })
  return { entries, updatedAt: new Date().toISOString() }
}

export function readConnectorRuntimeLogs(page: LogPage): ConnectorLogPage {
  return { entries: page.items.map(entry => ({ id: entry.seq, time: entry.time,
    text: `${entry.level} | ${entry.name} | ${entry.message}${entry.exception ? '\n' + entry.exception : ''}` })),
    hasMore: page.hasMoreBefore, oldestId: page.firstSeq ?? null, newestId: page.lastSeq ?? null }
}
