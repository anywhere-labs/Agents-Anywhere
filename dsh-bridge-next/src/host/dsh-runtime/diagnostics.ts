import type { Logger } from '@deepseek-ai/cordis'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BridgeError } from './errors.js'
import { record } from './types.js'

type Level = 'debug' | 'info' | 'warn' | 'error'
type Fields = Record<string, string | number | boolean | undefined>
type Sink = Pick<Logger, Level>
const quiet: Sink = { debug() {}, info() {}, warn() {}, error() {} }
const MAX_BYTES = 2 * 1024 * 1024

/** Native parser exceptions may quote a whole event. Keep codes and stack locations,
 * never exception messages, source lines, request bodies, tokens or event payloads. */
export function errorDetails(error: unknown, depth = 0): Record<string, unknown> {
  const value = record(error)
  const code = typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code) ? value.code : undefined
  const stack = error instanceof Error ? error.stack?.split('\n')
    .filter(line => /^\s+at .+:\d+:\d+\)?$/.test(line)).slice(0, 12).map(line => line.trim()) : undefined
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(code ? { errorCode: code } : {}),
    ...(error instanceof BridgeError ? { bridgeCode: error.code, retryable: error.retryable } : {}),
    ...(stack?.length ? { stack } : {}),
    ...(value.cause && depth < 3 ? { cause: errorDetails(value.cause, depth + 1) } : {}),
  }
}

/** Shared by the native reader, RPC server and event feed. The plugin's existing
 * Open logs folder action exposes this file, including when the CLI owns Connector. */
export class RuntimeDiagnostics {
  private pending: Promise<void> = Promise.resolve()
  private queued = 0
  private dropped = 0
  private fileErrorReported = false

  constructor(private sink: Sink = quiet, private directory?: string) {}

  log(level: Level, event: string, fields: Fields = {}, error?: unknown): void {
    const details = { ...fields, ...(error === undefined ? {} : errorDetails(error)) }
    this.sink[level]('event=%s %s', event, JSON.stringify(details))
    if (!this.directory) return
    if (this.queued >= 256) { this.dropped++; return }
    const entry = { time: new Date().toISOString(), pid: process.pid, level, event, ...details }
    this.queued++
    this.pending = this.pending.then(async () => {
      await mkdir(this.directory!, { recursive: true, mode: 0o700 })
      const path = join(this.directory!, 'dsh-runtime.jsonl')
      const size = await stat(path).then(file => file.size, () => 0)
      if (size > MAX_BYTES) await rename(path, join(this.directory!, 'dsh-runtime.previous.jsonl'))
      const dropped = this.dropped
      this.dropped = 0
      await appendFile(path, `${JSON.stringify({ ...entry, ...(dropped ? { droppedLogEntries: dropped } : {}) })}\n`, { mode: 0o600 })
    }).catch(error => {
      if (this.fileErrorReported) return
      this.fileErrorReported = true
      this.sink.error('event=diagnostics.write_failed %s', JSON.stringify(errorDetails(error)))
    }).finally(() => { this.queued-- })
  }

  async measure<T>(event: string, fields: Fields, action: () => Promise<T>): Promise<T> {
    const start = performance.now()
    this.log('debug', `${event}.started`, fields)
    try {
      const value = await action()
      this.log('debug', `${event}.completed`, { ...fields, elapsedMs: Math.round(performance.now() - start) })
      return value
    } catch (error) {
      this.log('error', `${event}.failed`, { ...fields, elapsedMs: Math.round(performance.now() - start) }, error)
      throw error
    }
  }

  async flush(): Promise<void> { await this.pending }
}

export const quietDiagnostics = new RuntimeDiagnostics()
