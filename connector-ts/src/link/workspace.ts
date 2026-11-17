// aa.device.v1.Workspace (normal mode): the 2.x workspace methods (files, terminals, shell) run through
// Workspace/call, and terminal output is pushed to the Server through Workspace/terminalOutput. The handlers share
// the same workspace implementation as the secure channel (sync/tunnel-api).
import { MeshCallError } from 'meshcall'

import type { BlobTransfer, TransferUpload, UploadFile } from './device-files.js'

/**
 * `WORKSPACE_METHODS` of contracts/device-meshcall/1.0 (server/agent_server/core/device_meshcall.py), declared here
 * until the generated contract types carry it: what `Workspace/call` runs; anything else is `invalid_argument`.
 */
export const WORKSPACE_METHODS = [
  'fs.readDir',
  'fs.readText',
  'fs.writeFile',
  'fs.prepareDownload',
  'fs.uploadPreparedDownload',
  'terminal.create',
  'terminal.list',
  'terminal.rename',
  'terminal.setPersistent',
  'terminal.close',
  'terminal.write',
  'terminal.resize',
  'terminal.snapshot',
  'shell.exec',
] as const

export type WorkspaceMethod = (typeof WORKSPACE_METHODS)[number]

/** `WorkspaceCallRequest` / `WorkspaceCallResponse` of the contract. */
export interface WorkspaceCallRequest {
  readonly method: string
  readonly params?: Record<string, unknown>
}

export interface WorkspaceCallResponse {
  readonly result: Record<string, unknown>
}

/** `TerminalOutputRequest` / `TerminalOutputItem` of the contract. */
export interface TerminalOutputRequest {
  readonly terminalId: string
  readonly sessionId: string
  readonly fromSeq?: number
}

export interface TerminalOutputItem {
  readonly m: 'terminal.replay' | 'terminal.output' | 'terminal.exited'
  readonly p: Record<string, unknown>
}

/** A workspace handler by 2.x method name (the same ones `sync/tunnel-api` serves through a secure channel). */
export type WorkspaceHandler = (params: Record<string, unknown>) => Promise<unknown>

/** Terminal events routed to one sink (`Terminals.attach`). */
export type TerminalEventSink = (method: 'terminal.output' | 'terminal.exited', params: Record<string, unknown>) => void

/** The part of the workspace `Terminals` the output streams use. */
export interface TerminalSource {
  attach(params: Record<string, unknown>, sink: TerminalEventSink): Promise<Record<string, unknown>>
  release(params: Record<string, unknown>, sink: TerminalEventSink): Promise<unknown>
  snapshot(params: Record<string, unknown>, includeScrollback?: boolean): Promise<Record<string, unknown>>
}

export interface WorkspaceServiceDeps {
  /** 2.x workspace handlers by method name (`workspaceMethods`); a method the device lacks is `unimplemented`. */
  readonly methods: Readonly<Record<string, WorkspaceHandler>>
  /** Terminals (node-pty); absent: `terminalOutput` answers `unimplemented`. */
  readonly terminals?: TerminalSource
  /** `fs.uploadPreparedDownload`: the checked local file of a prepared download, without hashing it again. */
  readonly preparedFile?: (params: Record<string, unknown>) => Promise<UploadFile>
  /** The transfer upload `Store/readBlob` uses (`deviceTransferUploader`). */
  readonly upload?: TransferUpload
  readonly onUploadError?: (transferId: string, error: unknown) => void
}

/** Without a change, a watcher looks at the terminal again after this long (so it notices a closed record that expired). */
export const TERMINAL_POLL_MS = 30_000
/** Largest `dataBase64` payload of one `terminal.output` item, in bytes before encoding. */
export const TERMINAL_OUTPUT_ITEM_BYTES = 512 * 1024

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new MeshCallError('invalid_argument', `${field} is required`)
  return value
}

function isWorkspaceMethod(method: string): method is WorkspaceMethod {
  return (WORKSPACE_METHODS as readonly string[]).includes(method)
}

/** `Workspace/call`: one whitelisted 2.x method, its 2.x params in and its 2.x result out. */
export async function workspaceCall(deps: WorkspaceServiceDeps, request: WorkspaceCallRequest): Promise<WorkspaceCallResponse> {
  const method = typeof request.method === 'string' ? request.method : ''
  if (!isWorkspaceMethod(method)) throw new MeshCallError('invalid_argument', `${method || '(none)'} is not a workspace method`)
  const params = record(request.params)
  if (method === 'fs.uploadPreparedDownload') return { result: await uploadPreparedDownload(deps, params) }
  const handler = deps.methods[method]
  if (handler === undefined) throw new MeshCallError('unimplemented', `${method} is not available on this device`)
  return { result: record(await handler(params)) }
}

/**
 * `fs.uploadPreparedDownload`: answers at once and sends the file in the background, so the Server can start
 * streaming the relay to its client. The bytes go to `uploadUrl`, a path on the Server
 * (`/api/v3/device/transfers/{transferId}`); another origin is refused.
 */
async function uploadPreparedDownload(deps: WorkspaceServiceDeps, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const transferId = text(params.transferId, 'transferId')
  const token = text(params.token, 'token')
  const uploadUrl = typeof params.uploadUrl === 'string' && params.uploadUrl !== '' ? params.uploadUrl : `/api/v3/device/transfers/${encodeURIComponent(transferId)}`
  if (!uploadUrl.startsWith('/') || uploadUrl.startsWith('//')) throw new MeshCallError('invalid_argument', 'uploadUrl must be a path on the Server')
  if (deps.upload === undefined || deps.preparedFile === undefined) throw new MeshCallError('unimplemented', 'file downloads are not available on this device')
  const file = await deps.preparedFile(params)
  const transfer: BlobTransfer = { transferId, token, path: uploadUrl }
  void deps.upload(transfer, file).catch(error => deps.onUploadError?.(transferId, error))
  return { transferId, uploadStarted: true }
}

interface Watcher {
  dirty: boolean
  wake: (() => void) | null
}

interface Group {
  readonly sessionId: string
  readonly sink: TerminalEventSink
  readonly watchers: Set<Watcher>
  /** The first attach (it also checks the terminal belongs to `sessionId`). */
  readonly attached: Promise<Record<string, unknown>>
  exit: Record<string, unknown> | null
}

/**
 * Several readers of one terminal (Server workers, clients): the workspace routes a terminal's events to a single
 * sink, so the group attaches once and wakes every reader; each reader then reads the scrollback at its own pace
 * (`Terminals.snapshot` from its last seq), so a slow one never holds up the others or grows a queue.
 */
export class TerminalWatchers {
  private readonly groups = new Map<string, Group>()

  public constructor(private readonly terminals: TerminalSource) {}

  /** Readers attached to a terminal now (tests, diagnostics). */
  public count(terminalId: string): number {
    return this.groups.get(terminalId)?.watchers.size ?? 0
  }

  private group(terminalId: string, sessionId: string): Group {
    const existing = this.groups.get(terminalId)
    if (existing !== undefined) {
      if (existing.sessionId !== sessionId) throw new MeshCallError('terminal_not_found', `terminal not found: ${terminalId}`)
      return existing
    }
    const watchers = new Set<Watcher>()
    const sink: TerminalEventSink = (method, params) => {
      if (method === 'terminal.exited') group.exit = params
      for (const watcher of watchers) {
        watcher.dirty = true
        watcher.wake?.()
      }
    }
    const attached = this.terminals.attach({ terminalId, sessionId }, sink)
    const group: Group = { sessionId, sink, watchers, attached, exit: null }
    this.groups.set(terminalId, group)
    attached.catch(() => {
      if (this.groups.get(terminalId) === group) this.groups.delete(terminalId)
    })
    return group
  }

  private leave(terminalId: string, group: Group, watcher: Watcher): void {
    group.watchers.delete(watcher)
    if (group.watchers.size > 0 || this.groups.get(terminalId) !== group) return
    this.groups.delete(terminalId)
    void this.terminals.release({ terminalId, sessionId: group.sessionId }, group.sink).catch(() => undefined)
  }

  /** `Workspace/terminalOutput`: a replay of the scrollback, output in order, then the exit; ends when `signal` aborts. */
  public async *stream(request: TerminalOutputRequest, signal: AbortSignal, pollMs = TERMINAL_POLL_MS): AsyncGenerator<TerminalOutputItem> {
    const terminalId = text(request.terminalId, 'terminalId')
    const sessionId = text(request.sessionId, 'sessionId')
    const group = this.group(terminalId, sessionId)
    const watcher: Watcher = { dirty: false, wake: null }
    group.watchers.add(watcher)
    // The reader that attached the group replays the attach snapshot; later readers take their own.
    const attachedHere = group.watchers.size === 1
    try {
      const attached = await group.attached
      const first = attachedHere ? attached : await this.terminals.snapshot({ terminalId, sessionId }, true)
      let last = typeof first.seq === 'number' ? first.seq : 0
      yield { m: 'terminal.replay', p: { terminalId, seq: last, dataBase64: typeof first.dataBase64 === 'string' ? first.dataBase64 : '', terminal: record(first.terminal) } }
      if (record(first.terminal).status === 'exited') {
        yield exited(terminalId, group.exit, record(first.terminal))
        return
      }
      while (!signal.aborted) {
        await this.wait(watcher, pollMs, signal)
        if (signal.aborted) return
        let current: Record<string, unknown>
        try {
          current = await this.terminals.snapshot({ terminalId, sessionId, fromSeq: last }, false)
        } catch (error) {
          // Closed and forgotten (`terminal.close`, expiry): the exit the sink saw, else `closed`.
          if ((error as { code?: unknown })?.code !== 'terminal_not_found') throw error
          yield exited(terminalId, group.exit ?? { exitCode: null, reason: 'closed' }, {})
          return
        }
        const baseSeq = typeof current.baseSeq === 'number' ? current.baseSeq : 0
        const seq = typeof current.seq === 'number' ? current.seq : last
        if (last < baseSeq) {
          // Fell out of the scrollback: redraw from it.
          yield { m: 'terminal.replay', p: { terminalId, seq, dataBase64: typeof current.dataBase64 === 'string' ? current.dataBase64 : '', terminal: record(current.terminal) } }
          last = seq
        } else {
          for (const item of outputItems(terminalId, current.outputs)) {
            yield item
            last = Number(item.p.seq)
          }
        }
        const terminal = record(current.terminal)
        if (group.exit !== null || terminal.status === 'exited') {
          yield exited(terminalId, group.exit, terminal)
          return
        }
      }
    } finally {
      this.leave(terminalId, group, watcher)
    }
  }

  private wait(watcher: Watcher, pollMs: number, signal: AbortSignal): Promise<void> {
    if (watcher.dirty || signal.aborted) {
      watcher.dirty = false
      return Promise.resolve()
    }
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        watcher.wake = null
        watcher.dirty = false
        resolve()
      }
      const timer = setTimeout(done, pollMs)
      timer.unref?.()
      signal.addEventListener('abort', done, { once: true })
      watcher.wake = done
    })
  }
}

function exited(terminalId: string, event: Record<string, unknown> | null, terminal: Record<string, unknown>): TerminalOutputItem {
  const exitCode = event?.exitCode ?? terminal.exitCode
  return { m: 'terminal.exited', p: { terminalId, exitCode: typeof exitCode === 'number' ? exitCode : null, reason: typeof event?.reason === 'string' ? event.reason : 'exit' } }
}

/** The chunks after the reader's seq, merged into items of at most `TERMINAL_OUTPUT_ITEM_BYTES`. */
function outputItems(terminalId: string, outputs: unknown): TerminalOutputItem[] {
  const items: TerminalOutputItem[] = []
  let parts: Buffer[] = []
  let size = 0
  let seq = 0
  const flush = (): void => {
    if (parts.length === 0) return
    items.push({ m: 'terminal.output', p: { terminalId, seq, dataBase64: Buffer.concat(parts).toString('base64') } })
    parts = []
    size = 0
  }
  for (const chunk of Array.isArray(outputs) ? outputs.map(record) : []) {
    if (typeof chunk.seq !== 'number' || typeof chunk.dataBase64 !== 'string') continue
    const data = Buffer.from(chunk.dataBase64, 'base64')
    if (size > 0 && size + data.length > TERMINAL_OUTPUT_ITEM_BYTES) flush()
    parts.push(data)
    size += data.length
    seq = chunk.seq
  }
  flush()
  return items
}
