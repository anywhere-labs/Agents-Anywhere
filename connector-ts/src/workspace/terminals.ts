// terminals-v2 with the behaviour of v2 connector/local/terminal.py (512 KiB scrollback replayed by sequence number,
// 30-minute idle timeout, 24-hour persistent lease, closed terminals kept 15 minutes, at most 32 records) on node-pty.
// ported from effi-crew cloud/agentd/src/terminals/tmux.ts @30f8334: `ensurePtyHelper` (node-pty's macOS
// spawn-helper loses its execute bit in npm installs, so every spawn failed with posix_spawnp) and the shell choice.
import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { WorkspaceError, invalid } from './errors.js'
import { nearestExistingDir, requiredString, resolvePath, workspaceRoot, type Params } from './params.js'
import type { RootPolicy } from './roots.js'

export const TERMINAL_SCROLLBACK_MAX_BYTES = 512 * 1024
export const TERMINAL_IDLE_TTL_MS = 30 * 60_000
export const TERMINAL_CLOSED_TTL_MS = 15 * 60_000
export const TERMINAL_PERSISTENT_LEASE_MS = 24 * 60 * 60_000
export const TERMINAL_MAX_RECORDS = 32
export const TERMINAL_REAPER_POLL_MS = 30_000

/** The part of a node-pty `IPty` the terminals use. */
export interface Pty {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export type SpawnPty = (file: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => Pty

/** Terminal events (`terminal.output`, `terminal.exited`) to a per-terminal relay, or to the device-wide sink. */
export type TerminalSink = (method: 'terminal.output' | 'terminal.exited', params: Record<string, unknown>) => void

export interface TerminalOptions {
  readonly policy: RootPolicy
  readonly spawn: SpawnPty
  readonly notify?: TerminalSink
  readonly now?: () => number
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly idleTtlMs?: number
  readonly closedTtlMs?: number
  readonly persistentLeaseMs?: number
  readonly reaperPollMs?: number
}

interface Chunk {
  readonly seq: number
  readonly data: Buffer
}

interface TerminalRecord {
  readonly id: string
  readonly sessionId: string
  readonly pty: Pty
  readonly cwd: string
  readonly shell: string
  readonly command: string | null
  readonly args: string[]
  readonly createdAt: string
  readonly createdAtMs: number
  label: string
  cols: number
  rows: number
  persistent: boolean
  leaseDeadlineMs: number | null
  closed: boolean
  status: 'running' | 'exited'
  exitCode: number | null
  lastActivityMs: number
  closedAtMs: number | null
  seq: number
  chunks: Chunk[]
  chunksBytes: number
  scrollback: Buffer
  scrollbackBaseSeq: number
  output: TerminalSink | null
  relayOnly: boolean
}

let helperChecked = false

/** node-pty's macOS `spawn-helper` loses its execute bit when installed with npm: put it back once. */
export function ensurePtyHelper(platform: NodeJS.Platform = process.platform): void {
  if (helperChecked || platform !== 'darwin') return
  helperChecked = true
  try {
    const root = join(createRequire(import.meta.url).resolve('node-pty/package.json'), '..')
    for (const dir of [join(root, 'prebuilds', `${process.platform}-${process.arch}`), join(root, 'build', 'Release')]) {
      const helper = join(dir, 'spawn-helper')
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755)
    }
  } catch {
    // Not fixable here (a read-only install): the spawn reports it.
  }
}

/** The node-pty spawner, loaded on first use so the rest of the Connector runs without the native module. */
export async function nodePtySpawner(): Promise<SpawnPty> {
  ensurePtyHelper()
  const pty = await import('node-pty')
  return (file, args, options) => pty.spawn(file, [...args], { name: 'xterm-256color', ...options })
}

export class Terminals {
  private readonly records = new Map<string, TerminalRecord>()
  private readonly now: () => number
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly idleTtlMs: number
  private readonly closedTtlMs: number
  private readonly leaseMs: number
  private reaper: NodeJS.Timeout | undefined

  public constructor(private readonly options: TerminalOptions) {
    this.now = options.now ?? Date.now
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.idleTtlMs = options.idleTtlMs ?? envMs(this.env, 'AGENT_CONNECTOR_TERMINAL_IDLE_TTL_SECONDS', TERMINAL_IDLE_TTL_MS)
    this.closedTtlMs = options.closedTtlMs ?? envMs(this.env, 'AGENT_CONNECTOR_TERMINAL_CLOSED_TTL_SECONDS', TERMINAL_CLOSED_TTL_MS)
    this.leaseMs = options.persistentLeaseMs ?? Math.max(60_000, envMs(this.env, 'AGENT_CONNECTOR_TERMINAL_PERSISTENT_LEASE_TTL_SECONDS', TERMINAL_PERSISTENT_LEASE_MS))
    const poll = options.reaperPollMs ?? Math.max(100, envMs(this.env, 'AGENT_CONNECTOR_TERMINAL_REAPER_POLL_SECONDS', TERMINAL_REAPER_POLL_MS))
    this.reaper = setInterval(() => this.reap(), poll)
    this.reaper.unref()
  }

  private defaultShell(requested: unknown): string {
    if (typeof requested === 'string' && requested.trim() !== '') return requested
    if (this.platform === 'win32') return 'powershell.exe'
    return this.env.SHELL ?? '/bin/bash'
  }

  private defaultArgs(shell: string): string[] {
    if (this.platform === 'win32') return /powershell(\.exe)?$/iu.test(shell) ? ['-NoLogo'] : []
    return /(bash|zsh|sh)$/u.test(shell) ? ['-l'] : []
  }

  /** `terminal.create` */
  public async create(params: Params, output?: TerminalSink): Promise<Record<string, unknown>> {
    this.gc()
    const root = workspaceRoot(params)
    const rawCwd = params.cwd
    const wanted = typeof rawCwd === 'string' && rawCwd.trim() !== '' ? resolvePath(root, rawCwd) : root
    await this.options.policy.check(wanted)
    let cwd = await nearestExistingDir(wanted, root)
    if (!(await this.options.policy.allows(cwd))) cwd = await nearestExistingDir(root)
    await this.options.policy.check(cwd)
    const terminalId = requiredString(params, 'terminalId')
    const sessionId = requiredString(params, 'sessionId')
    const cols = Number(params.cols ?? 0) || 80
    const rows = Number(params.rows ?? 0) || 24
    const label = typeof params.label === 'string' && params.label.trim() !== '' ? params.label.trim() : 'Shell'
    const persistent = params.persistent ?? false
    if (typeof persistent !== 'boolean') throw invalid('persistent must be a boolean')
    const command = params.command ?? null
    if (command !== null && typeof command !== 'string') throw invalid('command must be a string')
    const rawArgs = params.args ?? []
    if (!Array.isArray(rawArgs) || !rawArgs.every(arg => typeof arg === 'string')) throw invalid('args must be a list of strings')
    const args = rawArgs as string[]
    const shell = this.defaultShell(params.shell)
    const [file, argv] = typeof command === 'string' && command.trim() !== '' ? [command, args] : [shell, this.defaultArgs(shell)]
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.env)) if (value !== undefined) env[key] = value
    env.TERM ??= 'xterm-256color'
    env.COLORTERM ??= 'truecolor'
    const overrides = params.env
    if (overrides !== null && typeof overrides === 'object') {
      for (const [key, value] of Object.entries(overrides)) if (typeof value === 'string') env[key] = value
    }
    if (this.records.has(terminalId)) throw invalid(`terminal already exists: ${terminalId}`)

    let pty: Pty
    try {
      pty = this.options.spawn(file, argv, { cwd, env, cols, rows })
    } catch (error) {
      throw new WorkspaceError('terminal_spawn_failed', `could not start ${file}: ${(error as Error).message}`)
    }
    const now = this.now()
    const record: TerminalRecord = {
      id: terminalId,
      sessionId,
      pty,
      cwd,
      shell,
      command: typeof command === 'string' ? command : null,
      args,
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      label,
      cols,
      rows,
      persistent,
      leaseDeadlineMs: persistent ? now + this.leaseMs : null,
      closed: false,
      status: 'running',
      exitCode: null,
      lastActivityMs: now,
      closedAtMs: null,
      seq: 0,
      chunks: [],
      chunksBytes: 0,
      scrollback: Buffer.alloc(0),
      scrollbackBaseSeq: 0,
      output: output ?? null,
      relayOnly: output !== undefined || params.outputTransport === 'relay',
    }
    this.records.set(terminalId, record)
    pty.onData(data => this.onOutput(record, Buffer.from(data, 'utf8')))
    pty.onExit(event => {
      if (record.closed) return
      record.exitCode = event.exitCode
      this.emit(record, 'terminal.exited', { terminalId, sessionId, exitCode: event.exitCode, reason: 'exit' })
      this.markClosed(record)
    })
    return {
      terminalId,
      sessionId,
      label,
      purpose: 'user',
      pid: pty.pid,
      cwd,
      cols,
      rows,
      shell,
      command: record.command,
      args,
      status: record.status,
      exitCode: null,
      scrollbackBytes: 0,
      scrollbackSeq: 0,
      persistent,
      createdAt: record.createdAt,
    }
  }

  private require(terminalId: string): TerminalRecord {
    const record = this.records.get(terminalId)
    if (record === undefined) throw new WorkspaceError('terminal_not_found', `terminal not found: ${terminalId}`)
    return record
  }

  /** `terminal.write` */
  public async write(params: Params): Promise<Record<string, unknown>> {
    this.gc()
    const terminalId = requiredString(params, 'terminalId')
    const record = this.require(terminalId)
    if (record.closed) throw invalid(`terminal already closed: ${terminalId}`)
    const raw = requiredString(params, 'dataBase64')
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(raw) || raw.length % 4 === 1) throw invalid('dataBase64 must be valid base64')
    const data = Buffer.from(raw, 'base64')
    record.lastActivityMs = this.now()
    record.pty.write(data)
    return { terminalId, bytesWritten: data.length }
  }

  /** `terminal.resize`: clamped to 500×200; a missing terminal answers `closed: true`. */
  public async resize(params: Params): Promise<Record<string, unknown>> {
    this.gc()
    const terminalId = requiredString(params, 'terminalId')
    const record = this.records.get(terminalId)
    if (record === undefined) return { terminalId, closed: true }
    const cols = Math.max(1, Math.min(500, Math.trunc(Number(params.cols ?? 0) || record.cols)))
    const rows = Math.max(1, Math.min(200, Math.trunc(Number(params.rows ?? 0) || record.rows)))
    if (!record.closed) {
      try {
        record.pty.resize(cols, rows)
      } catch {
        // The process may have just exited.
      }
    }
    record.lastActivityMs = this.now()
    record.cols = cols
    record.rows = rows
    return { terminalId, cols, rows }
  }

  /** `terminal.close` */
  public async close(params: Params): Promise<Record<string, unknown>> {
    this.gc()
    const terminalId = requiredString(params, 'terminalId')
    const record = this.records.get(terminalId)
    if (record === undefined) return { terminalId, closed: true }
    if (record.relayOnly) this.emit(record, 'terminal.exited', { terminalId, sessionId: record.sessionId, exitCode: record.exitCode, reason: 'closed' })
    this.kill(record)
    this.records.delete(terminalId)
    return { terminalId, closed: true }
  }

  /** `terminal.rename` */
  public async rename(params: Params): Promise<Record<string, unknown>> {
    this.gc()
    const record = this.require(requiredString(params, 'terminalId'))
    const label = requiredString(params, 'label').trim()
    if (label === '') throw invalid('label is required')
    record.label = label
    return this.view(record)
  }

  /** `terminal.setPersistent`: a persistent terminal survives idleness for the lease (24 h by default). */
  public async setPersistent(params: Params): Promise<Record<string, unknown>> {
    this.gc()
    const record = this.require(requiredString(params, 'terminalId'))
    const persistent = params.persistent
    if (typeof persistent !== 'boolean') throw invalid('persistent must be a boolean')
    record.persistent = persistent
    record.leaseDeadlineMs = persistent ? this.now() + this.leaseMs : null
    return this.view(record)
  }

  /** Route a terminal's output to a relay (`terminal.relay.connect`) and return the snapshot to replay. */
  public async attach(params: Params, output: TerminalSink): Promise<Record<string, unknown>> {
    const terminalId = requiredString(params, 'terminalId')
    const record = this.records.get(terminalId)
    if (record === undefined || record.sessionId !== requiredString(params, 'sessionId')) {
      throw new WorkspaceError('terminal_not_found', `terminal not found: ${terminalId}`)
    }
    record.relayOnly = true
    record.output = output
    return this.snapshot(params)
  }

  /** `terminal.release`: detach a relay; a replaced relay never detaches the newer one. */
  public async release(params: Params, output?: TerminalSink): Promise<Record<string, unknown>> {
    this.gc()
    const terminalId = requiredString(params, 'terminalId')
    const record = this.records.get(terminalId)
    if (record !== undefined && (output === undefined || record.output === output)) record.output = null
    return { terminalId, released: true }
  }

  /** `terminal.list` */
  public async list(params: Params): Promise<Record<string, unknown>> {
    this.gc()
    const sessionId = params.sessionId
    return { terminals: [...this.records.values()].filter(record => sessionId === undefined || sessionId === null || record.sessionId === sessionId).map(record => this.view(record)) }
  }

  /**
   * `terminal.snapshot`: the scrollback (512 KiB) and the chunks after `fromSeq`. With `includeScrollback: false`
   * the full buffer is sent only when `fromSeq` fell out of it.
   */
  public async snapshot(params: Params, includeScrollback = true): Promise<Record<string, unknown>> {
    this.gc()
    const record = this.require(requiredString(params, 'terminalId'))
    const fromSeq = Number(params.fromSeq ?? 0) || 0
    return {
      terminal: this.view(record),
      baseSeq: record.scrollbackBaseSeq,
      seq: record.seq,
      dataBase64: includeScrollback || fromSeq < record.scrollbackBaseSeq ? record.scrollback.toString('base64') : '',
      outputs: record.chunks.filter(chunk => chunk.seq > fromSeq).map(chunk => ({ seq: chunk.seq, dataBase64: chunk.data.toString('base64') })),
    }
  }

  /** Kills every terminal (shutdown). */
  public shutdown(): void {
    if (this.reaper !== undefined) clearInterval(this.reaper)
    this.reaper = undefined
    for (const record of this.records.values()) this.kill(record)
    this.records.clear()
  }

  private onOutput(record: TerminalRecord, data: Buffer): void {
    if (record.closed || data.length === 0) return
    record.lastActivityMs = this.now()
    record.seq += 1
    record.chunks.push({ seq: record.seq, data })
    record.chunksBytes += data.length
    while (record.chunks.length > 0 && record.chunksBytes > TERMINAL_SCROLLBACK_MAX_BYTES) {
      record.chunksBytes -= record.chunks.shift()!.data.length
    }
    let scrollback = Buffer.concat([record.scrollback, data])
    const overflow = scrollback.length - TERMINAL_SCROLLBACK_MAX_BYTES
    if (overflow > 0) {
      scrollback = scrollback.subarray(overflow)
      record.scrollbackBaseSeq = record.chunks.length > 0 ? record.chunks[0]!.seq - 1 : record.seq
    }
    record.scrollback = scrollback
    this.emit(record, 'terminal.output', { terminalId: record.id, sessionId: record.sessionId, seq: record.seq, dataBase64: data.toString('base64') })
  }

  private emit(record: TerminalRecord, method: 'terminal.output' | 'terminal.exited', params: Record<string, unknown>): void {
    if (record.output !== null) {
      record.output(method, params)
      return
    }
    if (record.relayOnly) return
    this.options.notify?.(method, params)
  }

  private markClosed(record: TerminalRecord): void {
    if (record.closed) return
    record.closed = true
    record.status = 'exited'
    record.closedAtMs = this.now()
  }

  private kill(record: TerminalRecord): void {
    if (record.closed) return
    this.markClosed(record)
    try {
      record.pty.kill()
    } catch {
      // Already gone.
    }
  }

  private expire(record: TerminalRecord, reason: string): void {
    if (record.closed || this.records.get(record.id) !== record) return
    this.emit(record, 'terminal.exited', { terminalId: record.id, sessionId: record.sessionId, exitCode: null, reason })
    this.kill(record)
    this.records.delete(record.id)
  }

  /** Idle and lease expiry, and forgetting closed terminals (v2 `_reap_terminal`). */
  public reap(): void {
    const now = this.now()
    for (const record of [...this.records.values()]) {
      if (record.closed) {
        if (now - (record.closedAtMs ?? now) >= this.closedTtlMs) this.records.delete(record.id)
        continue
      }
      if (record.persistent) {
        if (record.leaseDeadlineMs === null || now >= record.leaseDeadlineMs) this.expire(record, 'persistent_lease_expired')
        continue
      }
      if (this.idleTtlMs > 0 && now - record.lastActivityMs >= this.idleTtlMs) this.expire(record, 'idle_timeout')
    }
  }

  private gc(): void {
    const now = this.now()
    for (const record of [...this.records.values()]) {
      if (record.closed && record.closedAtMs !== null && now - record.closedAtMs > this.closedTtlMs) this.records.delete(record.id)
    }
    if (this.records.size <= TERMINAL_MAX_RECORDS) return
    const closed = [...this.records.values()].filter(record => record.closed).sort((a, b) => (a.closedAtMs ?? a.createdAtMs) - (b.closedAtMs ?? b.createdAtMs))
    for (const record of closed) {
      if (this.records.size <= TERMINAL_MAX_RECORDS) break
      this.records.delete(record.id)
    }
  }

  private view(record: TerminalRecord): Record<string, unknown> {
    return {
      terminalId: record.id,
      sessionId: record.sessionId,
      label: record.label,
      purpose: 'user',
      pid: record.closed ? null : record.pty.pid,
      cols: record.cols,
      rows: record.rows,
      cwd: record.cwd,
      shell: record.shell,
      closed: record.closed,
      status: record.status,
      exitCode: record.exitCode,
      scrollbackBytes: record.scrollback.length,
      scrollbackSeq: record.seq,
      persistent: record.persistent,
      createdAt: record.createdAt,
    }
  }
}

function envMs(env: NodeJS.ProcessEnv, name: string, fallbackMs: number): number {
  const raw = env[name]
  if (raw === undefined) return fallbackMs
  const seconds = Number(raw)
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : fallbackMs
}
