// JSON-RPC 2.0 对等端：ACP 的线路层（ndjson，一行一条消息）。
//
// 自己实现而不用 SDK 的运行时客户端：需要完整控制反向扩展请求（`_codex/session/history_reset` 等）、
// 未知方法的回退、v1/v2 协商与录制回放。单条消息上限沿用 agentd 的 256 MiB（超限即断开连接，
// 由监督层结束进程），见 effi-evo cloud/agentd/src/conv/agent-process.ts @95b52ec。

import type { Readable, Writable } from 'node:stream'

export type JsonRpcId = number | string

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** ACP：需要认证。 */
  authRequired: -32000,
  /** ACP：资源不存在。 */
  resourceNotFound: -32002,
  /** LSP / ACP v2：请求被取消。 */
  requestCancelled: -32800,
} as const

export class JsonRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'JsonRpcError'
  }

  static methodNotFound(method: string): JsonRpcError {
    return new JsonRpcError(ErrorCodes.methodNotFound, `Method not found: ${method}`)
  }

  static invalidParams(message: string, data?: unknown): JsonRpcError {
    return new JsonRpcError(ErrorCodes.invalidParams, message, data)
  }
}

/** 连接已断开（对端退出、超限、手动关闭）。 */
export class ConnectionClosedError extends Error {
  constructor(readonly reason: string) {
    super(`ACP connection closed: ${reason}`)
    this.name = 'ConnectionClosedError'
  }
}

/** 请求在规定时间内没有回应：结果未知，调用方不得自动重试写操作。 */
export class RequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs} ms`)
    this.name = 'RequestTimeoutError'
  }
}

// ---------------------------------------------------------------------------------------------
// 传输
// ---------------------------------------------------------------------------------------------

export interface MessageTransport {
  send(message: JsonRpcMessage): void
  /** 只能设置一次。 */
  start(onMessage: (message: JsonRpcMessage) => void, onClose: (reason: string) => void): void
  close(reason?: string): void
}

/** 默认单条消息上限：256 MiB。 */
export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024 * 1024

/** stdio ndjson 传输。超过上限或出现不是 JSON 的行时关闭连接（不尝试跳过：对端状态已不可信）。 */
export function ndjsonTransport(input: Readable, output: Writable, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES): MessageTransport {
  let closed = false
  let onClose: ((reason: string) => void) | undefined
  const finish = (reason: string): void => {
    if (closed) return
    closed = true
    input.removeAllListeners('data')
    onClose?.(reason)
  }
  // 对端已退出时写入会异步报 EPIPE / ERR_STREAM_DESTROYED：没有监听就是未捕获异常，整个 Connector 退出。
  // 这里把它转成连接关闭，挂着的请求得到 ConnectionClosedError（runtime_disconnected）。
  output.on('error', error => finish(`ACP write failed: ${error.message}`))
  return {
    send(message) {
      if (closed) throw new ConnectionClosedError('closed')
      if (output.destroyed || output.writableEnded) {
        finish('ACP connection closed')
        throw new ConnectionClosedError('ACP connection closed')
      }
      output.write(JSON.stringify(message) + '\n')
    },
    start(onMessage, close) {
      onClose = close
      let pending: Buffer[] = []
      let pendingBytes = 0
      input.on('data', (chunk: Buffer) => {
        let start = 0
        for (;;) {
          const newline = chunk.indexOf(0x0a, start)
          if (newline === -1) break
          const piece = chunk.subarray(start, newline)
          start = newline + 1
          if (pendingBytes + piece.length > maxMessageBytes) return finish(`message over ${maxMessageBytes} bytes`)
          const line = (pending.length ? Buffer.concat([...pending, piece]) : piece).toString('utf8').trim()
          pending = []
          pendingBytes = 0
          if (line === '') continue
          let message: JsonRpcMessage
          try {
            message = JSON.parse(line) as JsonRpcMessage
          } catch {
            return finish(`invalid JSON from agent: ${line.slice(0, 200)}`)
          }
          if (closed) return
          onMessage(message)
        }
        if (start < chunk.length) {
          const rest = chunk.subarray(start)
          pendingBytes += rest.length
          if (pendingBytes > maxMessageBytes) return finish(`message over ${maxMessageBytes} bytes`)
          pending.push(Buffer.from(rest))
        }
      })
      input.once('end', () => finish('ACP connection closed'))
      input.once('error', error => finish(error.message))
    },
    close(reason = 'closed by client') {
      if (closed) return
      output.end()
      finish(reason)
    },
  }
}

/** 进程内的一对传输（测试、录制回放）。消息经 JSON 往返，模拟线路上的序列化。 */
export function memoryTransportPair(): [MessageTransport, MessageTransport] {
  interface End {
    handler?: (message: JsonRpcMessage) => void
    onClose?: (reason: string) => void
    queue: JsonRpcMessage[]
    closed: boolean
  }
  const ends: [End, End] = [{ queue: [], closed: false }, { queue: [], closed: false }]
  const deliver = (to: End, message: JsonRpcMessage): void => {
    if (to.closed) return
    const copy = JSON.parse(JSON.stringify(message)) as JsonRpcMessage
    queueMicrotask(() => {
      if (to.closed) return
      if (to.handler) to.handler(copy)
      else to.queue.push(copy)
    })
  }
  const end = (target: End, reason: string): void => {
    if (target.closed) return
    target.closed = true
    queueMicrotask(() => target.onClose?.(reason))
  }
  const make = (self: End, other: End): MessageTransport => ({
    send(message) {
      if (self.closed) throw new ConnectionClosedError('closed')
      deliver(other, message)
    },
    start(onMessage, onClose) {
      self.handler = onMessage
      self.onClose = onClose
      for (const message of self.queue.splice(0)) onMessage(message)
    },
    close(reason = 'closed') {
      end(self, reason)
      end(other, reason)
    },
  })
  return [make(ends[0], ends[1]), make(ends[1], ends[0])]
}

// ---------------------------------------------------------------------------------------------
// 对等端
// ---------------------------------------------------------------------------------------------

export interface RequestContext {
  /** 对端取消请求（`$/cancel_request`）或连接关闭时触发。 */
  readonly signal: AbortSignal
  readonly method: string
}

export type RequestHandler = (params: unknown, context: RequestContext) => unknown
export type NotificationHandler = (params: unknown, method: string) => void

export interface RequestOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export type MessageTap = (direction: 'outgoing' | 'incoming', message: JsonRpcMessage) => void

interface Pending {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

export class JsonRpcPeer {
  private nextId = 0
  private readonly pending = new Map<JsonRpcId, Pending>()
  private readonly incoming = new Map<JsonRpcId, AbortController>()
  private readonly requestHandlers = new Map<string, RequestHandler>()
  private readonly notificationHandlers = new Map<string, NotificationHandler>()
  private fallbackRequest: RequestHandler | undefined
  private fallbackNotification: NotificationHandler | undefined
  private closedReason: string | undefined
  private readonly closedWaiters: ((reason: string) => void)[] = []
  private readonly taps: MessageTap[] = []

  constructor(private readonly transport: MessageTransport) {
    transport.start(message => this.receive(message), reason => this.closed(reason))
  }

  get isClosed(): boolean {
    return this.closedReason !== undefined
  }

  /** 连接关闭时 resolve（原因）。 */
  whenClosed(): Promise<string> {
    if (this.closedReason !== undefined) return Promise.resolve(this.closedReason)
    return new Promise(resolve => this.closedWaiters.push(resolve))
  }

  tap(listener: MessageTap): () => void {
    this.taps.push(listener)
    return () => {
      const index = this.taps.indexOf(listener)
      if (index >= 0) this.taps.splice(index, 1)
    }
  }

  onRequest(method: string, handler: RequestHandler): this {
    this.requestHandlers.set(method, handler)
    return this
  }

  onNotification(method: string, handler: NotificationHandler): this {
    this.notificationHandlers.set(method, handler)
    return this
  }

  /** 没注册的请求交给它；不设时回 method_not_found。 */
  onUnknownRequest(handler: RequestHandler): this {
    this.fallbackRequest = handler
    return this
  }

  onUnknownNotification(handler: NotificationHandler): this {
    this.fallbackNotification = handler
    return this
  }

  request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closedReason !== undefined) return Promise.reject(new ConnectionClosedError(this.closedReason))
    const id = this.nextId++
    const message: JsonRpcRequest = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve: resolve as (value: unknown) => void, reject }
      this.pending.set(id, entry)
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new RequestTimeoutError(method, options.timeoutMs!))
        }, options.timeoutMs)
        entry.timer.unref?.()
      }
      options.signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return
        if (entry.timer) clearTimeout(entry.timer)
        this.safeSend({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: id } })
        reject(options.signal?.reason ?? new JsonRpcError(ErrorCodes.requestCancelled, 'cancelled'))
      }, { once: true })
      try {
        this.send(message)
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closedReason !== undefined) throw new ConnectionClosedError(this.closedReason)
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  close(reason = 'closed by client'): void {
    this.transport.close(reason)
    this.closed(reason)
  }

  private send(message: JsonRpcMessage): void {
    for (const tap of this.taps) tap('outgoing', message)
    this.transport.send(message)
  }

  private safeSend(message: JsonRpcMessage): void {
    try {
      this.send(message)
    } catch {
      // 连接已关闭
    }
  }

  private receive(message: JsonRpcMessage): void {
    for (const tap of this.taps) tap('incoming', message)
    if ('method' in message && typeof message.method === 'string') {
      if ('id' in message && message.id !== undefined && message.id !== null) {
        void this.handleRequest(message as JsonRpcRequest)
      } else {
        this.handleNotification(message as JsonRpcNotification)
      }
      return
    }
    const response = message as JsonRpcResponse
    if (response.id === null || response.id === undefined) return
    const entry = this.pending.get(response.id)
    if (!entry) return
    this.pending.delete(response.id)
    if (entry.timer) clearTimeout(entry.timer)
    if (response.error) entry.reject(new JsonRpcError(response.error.code, response.error.message, response.error.data))
    else entry.resolve(response.result ?? null)
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (message.method === '$/cancel_request') {
      const requestId = (message.params as { requestId?: JsonRpcId } | undefined)?.requestId
      if (requestId !== undefined) this.incoming.get(requestId)?.abort(new JsonRpcError(ErrorCodes.requestCancelled, 'cancelled by agent'))
      return
    }
    const handler = this.notificationHandlers.get(message.method) ?? this.fallbackNotification
    if (!handler) return
    try {
      handler(message.params, message.method)
    } catch {
      // 通知没有回应；处理器的错误不影响连接
    }
  }

  private async handleRequest(message: JsonRpcRequest): Promise<void> {
    const controller = new AbortController()
    this.incoming.set(message.id, controller)
    const handler = this.requestHandlers.get(message.method) ?? this.fallbackRequest
    try {
      if (!handler) throw JsonRpcError.methodNotFound(message.method)
      const result = await handler(message.params, { signal: controller.signal, method: message.method })
      this.safeSend({ jsonrpc: '2.0', id: message.id, result: result ?? null })
    } catch (error) {
      const rpc = error instanceof JsonRpcError
        ? error
        : new JsonRpcError(ErrorCodes.internalError, error instanceof Error ? error.message : String(error))
      this.safeSend({ jsonrpc: '2.0', id: message.id, error: { code: rpc.code, message: rpc.message, ...(rpc.data === undefined ? {} : { data: rpc.data }) } })
    } finally {
      this.incoming.delete(message.id)
    }
  }

  private closed(reason: string): void {
    if (this.closedReason !== undefined) return
    this.closedReason = reason
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(new ConnectionClosedError(reason))
    }
    this.pending.clear()
    for (const controller of this.incoming.values()) controller.abort(new ConnectionClosedError(reason))
    this.incoming.clear()
    for (const waiter of this.closedWaiters.splice(0)) waiter(reason)
  }
}
