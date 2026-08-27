/**
 * Newline-delimited JSON-RPC client bound to a `ProcessRunner` subprocess.
 *
 * Wire shape — one JSON object per line, UTF-8, no embedded `\n`:
 *
 *   request      → `{ jsonrpc: '2.0', id, method, params }`
 *   response     ← `{ jsonrpc: '2.0', id, result | error }`
 *   notification → `{ jsonrpc: '2.0', method, params }`
 *
 * The client owns:
 *   - the `pending` map of in-flight `id → { resolve, reject }`
 *   - the line buffer for partial incoming frames
 *   - the monotonic request id
 *
 * Outbound writes go to `process.stdin` of the live child; incoming frames
 * come from `process.stdout`. Stderr is reserved for log lines (handled by
 * the `ProcessRunner`).
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { JsonRpcError } from './jsonrpc.js'
import type { ConnectorLogEvent, ProcessRunner } from './process-runner.js'

export interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

export interface RpcRequest<TParams = unknown> {
  readonly jsonrpc: '2.0'
  readonly id: string
  readonly method: string
  readonly params?: TParams
}

export interface RpcResponse<TResult = unknown> {
  readonly jsonrpc: '2.0'
  readonly id: string
  readonly result?: TResult
  readonly error?: RpcErrorPayload
}

export interface RpcNotification<TParams = unknown> {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: TParams
}

export interface RpcErrorPayload {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface RpcClientEvents {
  notification: (method: string, params: unknown) => void
  request: (method: string, params: unknown) => void
  close: () => void
  error: (error: Error) => void
}

export declare interface RpcClient {
  on<K extends keyof RpcClientEvents>(event: K, listener: RpcClientEvents[K]): this
  off<K extends keyof RpcClientEvents>(event: K, listener: RpcClientEvents[K]): this
  emit<K extends keyof RpcClientEvents>(event: K, ...args: Parameters<RpcClientEvents[K]>): boolean
}

/**
 * Minimal interface satisfied by the `ProcessRunner` we depend on. Kept
 * narrow so the client is easy to drive from tests with a fake stream pair.
 */
export interface RpcClientTransport {
  getStdin(): NodeJS.WritableStream | null
  getStdout(): NodeJS.ReadableStream | null
  onLog(handler: (entry: ConnectorLogEvent) => void): () => void
  onExit(handler: () => void): () => void
}

export class RpcClient extends EventEmitter {
  private readonly pending = new Map<string, PendingRequest>()
  private buffer = ''
  private closed = false
  private readonly transport: RpcClientTransport

  constructor(transport: RpcClientTransport) {
    super()
    this.transport = transport
    // Always have at least one 'error' listener so a peer crash doesn't
    // throw an uncaught exception into the host process. Callers should
    // attach their own listener to surface the error; this default swallows
    // only the throw.
    this.on('error', () => undefined)
    const stdout = transport.getStdout()
    if (stdout !== null) {
      stdout.setEncoding('utf8')
      stdout.on('data', (chunk: string) => this.accept(chunk))
      // The transport may not surface a discrete exit event; closing the
      // readable end is the authoritative "the peer hung up" signal.
      stdout.on('end', () => this.handleTransportExit())
      stdout.on('close', () => this.handleTransportExit())
    }
    transport.onExit(() => this.handleTransportExit())
  }

  /** Send a request and wait for the matching response. */
  send<TResult>(method: string, params?: unknown): Promise<TResult> {
    if (this.closed) return Promise.reject(new Error('rpc client closed'))
    const id = randomUUID()
    const message: RpcRequest = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.write(message)
    })
  }

  /** Fire-and-forget notification; the peer does not respond. */
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    const message: RpcNotification = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }
    this.write(message)
  }

  /** Reject every pending request and stop accepting new ones. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const error = new Error('rpc client closed')
    for (const [, pending] of this.pending) pending.reject(error)
    this.pending.clear()
    this.emit('close')
  }

  private write(frame: object): void {
    const stdin = this.transport.getStdin()
    if (stdin === null) {
      this.emit('error', new Error('rpc client: stdin unavailable'))
      return
    }
    stdin.write(`${JSON.stringify(frame)}\n`)
  }

  private accept(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.length > 0) this.handleLine(line)
      newlineIndex = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      this.emit('error', new Error(`rpc client: invalid JSON frame: ${line.slice(0, 120)}`))
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const frame = parsed as Record<string, unknown>
    if (typeof frame.id === 'string') {
      // Response or request from the peer (a request frame always carries
      // a `method`; a response frame carries `result`/`error` instead).
      const pending = this.pending.get(frame.id)
      if (pending === undefined) {
        // A peer-pushed request without a matching local pending entry is
        // dispatched as a server-initiated call (informational, no ack).
        if (typeof frame.method === 'string') {
          this.emit('request', frame.method, frame.params ?? {})
        }
        return
      }
      this.pending.delete(frame.id)
      if ('error' in frame && frame.error !== undefined && frame.error !== null) {
        const errorPayload = frame.error as RpcErrorPayload
        pending.reject(new JsonRpcError(errorPayload.code, errorPayload.message, errorPayload.data))
      } else {
        pending.resolve(frame.result)
      }
      return
    }
    if (typeof frame.method === 'string') {
      // Notification from the peer.
      this.emit('notification', frame.method, frame.params ?? {})
    }
  }

  private handleTransportExit(): void {
    if (this.closed) return
    const error = new Error('rpc client: transport exited')
    for (const [, pending] of this.pending) pending.reject(error)
    this.pending.clear()
    this.closed = true
    this.emit('error', error)
    this.emit('close')
  }
}

/** Adapter that exposes a `ProcessRunner` through the `RpcClientTransport` shape. */
export function runnerToTransport(runner: ProcessRunner): RpcClientTransport {
  // The runner owns its own `ChildProcess`; we reach into it lazily because
  // the stream objects only exist after `start()` has spawned the child.
  return {
    getStdin: () => (runner as unknown as { current?: { stdin: NodeJS.WritableStream | null } }).current?.stdin ?? null,
    getStdout: () => (runner as unknown as { current?: { stdout: NodeJS.ReadableStream | null } }).current?.stdout ?? null,
    onLog: (handler) => {
      const wrapped = (entry: ConnectorLogEvent): void => handler(entry)
      runner.on('log', wrapped)
      return () => runner.off('log', wrapped)
    },
    onExit: (handler) => {
      runner.on('state', (state) => {
        if (state === 'crashed' || state === 'stopped') handler()
      })
      return () => {
        // EventEmitter.off by reference requires the exact wrapper; we
        // intentionally leak this one-off because the rpc client lives as
        // long as the transport and re-registers on reconnect.
      }
    },
  }
}