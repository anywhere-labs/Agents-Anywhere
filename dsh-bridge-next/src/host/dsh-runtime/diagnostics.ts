import type { RpcLogger } from 'meshcall'
import { format } from 'node:util'
import { BridgeError } from './errors.js'
import { record } from './types.js'

export type Level = 'debug' | 'info' | 'warn' | 'error'
export type Fields = Record<string, string | number | boolean | undefined>
export interface DiagnosticEntry { time: string; level: Level; name: string; message: string; details: string }
export interface DiagnosticOutput { write(entry: DiagnosticEntry): void; flush(): Promise<void> }
const quiet: DiagnosticOutput = { write() {}, async flush() {} }

/** Native parser exceptions may quote a whole event. Keep codes and stack locations,
 * never exception messages, source lines, request bodies, tokens or event payloads. */
export function errorDetails(error: unknown, depth = 0): Record<string, unknown> {
  const value = record(error)
  const code = typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code) ? value.code : undefined
  const stack = error instanceof Error ? error.stack?.split('\n')
    .filter(line => /^\s+at .+:\d+:\d+\)?$/.test(line)).slice(0, 12).map(line => line.trim()) : undefined
  // Extract only numeric context from the official persistence validator.
  const gap = error instanceof Error ? error.message.match(/^corrupt session log: seq gap in committed region at line (\d+) \(expected (\d+), got (\d+)\)$/) : null
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(code ? { errorCode: code } : {}),
    ...(error instanceof BridgeError ? { bridgeCode: error.code, retryable: error.retryable } : {}),
    ...(stack?.length ? { stack } : {}),
    ...(gap ? { reason: 'sequence_gap', line: Number(gap[1]), expectedSeq: Number(gap[2]), actualSeq: Number(gap[3]) } : {}),
    ...(value.cause && depth < 3 ? { cause: errorDetails(value.cause, depth + 1) } : {}),
  }
}

/** Business diagnostics depend on an injected output, never on a path or RPC connection. */
export class RuntimeDiagnostics {
  constructor(
    private readonly output: DiagnosticOutput = quiet,
    private readonly fields: Fields = {},
    private readonly name = 'dsh-bridge',
  ) {}

  bind(fields: Fields): RuntimeDiagnostics { return new RuntimeDiagnostics(this.output, { ...this.fields, ...fields }, this.name) }

  log(level: Level, event: string, fields: Fields = {}, error?: unknown): void {
    const details = { ...this.fields, ...fields, ...(error === undefined ? {} : errorDetails(error)) }
    const serialized = JSON.stringify(details)
    try {
      this.output.write({ time: new Date().toISOString(), level, name: this.name, message: event.slice(0, 16000),
        details: serialized.length <= 16000 ? serialized : JSON.stringify({ truncated: true, summary: serialized.slice(0, 12000) }) })
    } catch { /* Logging cannot fail native event delivery or RPC handling. */ }
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

  async flush(): Promise<void> { await this.output.flush() }
}

/** The same injected output receives framework access logs and per-call loggers. */
export class RuntimeRpcLogger implements RpcLogger {
  constructor(private readonly diagnostics: RuntimeDiagnostics, private readonly fields: Fields = {}) {}
  bind(context: Readonly<Record<string, unknown>>): RpcLogger {
    const safe: Fields = {}
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') safe[key] = value
    }
    return new RuntimeRpcLogger(this.diagnostics, { ...this.fields, ...safe })
  }
  log(level: 'debug' | 'info' | 'warning' | 'error', message: string, ...args: unknown[]): void {
    if (this.fields.service === 'aa.local.v2.Logs') return
    const safe = args.map(value => value instanceof Error ? errorDetails(value) : value)
    this.diagnostics.log(level === 'warning' ? 'warn' : level, format(message, ...safe), this.fields)
  }
  debug(message: string, ...args: unknown[]): void { this.log('debug', message, ...args) }
  info(message: string, ...args: unknown[]): void { this.log('info', message, ...args) }
  warning(message: string, ...args: unknown[]): void { this.log('warning', message, ...args) }
  error(message: string, ...args: unknown[]): void { this.log('error', message, ...args) }
}

export const quietDiagnostics = new RuntimeDiagnostics()
