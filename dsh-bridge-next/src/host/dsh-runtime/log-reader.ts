import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { BridgeLogEntry, BridgeLogSnapshot } from '../../contracts/logs.js'
import { record } from './types.js'

async function tail(path: string): Promise<string[]> {
  const file = await open(path, 'r').catch(error => {
    if (record(error).code === 'ENOENT') return undefined
    throw error
  })
  if (!file) return []
  try {
    const { size } = await file.stat()
    const start = Math.max(0, size - 256 * 1024)
    const buffer = Buffer.alloc(size - start)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (start) lines.shift()
    return lines
  } finally { await file.close() }
}

/** Only our fixed runtime log files are exposed; no Host logs or caller paths. */
export async function readBridgeLogs(directory: string): Promise<BridgeLogSnapshot> {
  const entries: BridgeLogEntry[] = []
  for (const name of ['dsh-runtime.previous.jsonl', 'dsh-runtime.jsonl']) {
    for (const line of await tail(join(directory, name))) {
      try {
        const { time, level, event, ...details } = record(JSON.parse(line))
        if (typeof time !== 'string' || typeof event !== 'string' || !['debug', 'info', 'warn', 'error'].includes(String(level))) continue
        entries.push({ time, level: level as BridgeLogEntry['level'], event, details: JSON.stringify(details, null, 2) })
      } catch { /* A concurrent append may leave the last line incomplete. */ }
    }
  }
  return { entries: entries.slice(-200), updatedAt: new Date().toISOString() }
}
