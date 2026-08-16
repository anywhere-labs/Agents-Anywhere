import type { JsonObject, JsonRpcRequest } from './types.js'

export class RpcFault extends Error {
  constructor(readonly code: string, message: string, readonly details?: JsonObject) {
    super(message)
  }
}

const ERROR_CODES: Record<string, number> = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_INITIALIZED: -32001,
  ALREADY_INITIALIZED: -32002,
  PROTOCOL_VERSION_MISMATCH: -32003,
  SHUTTING_DOWN: -32004,
  FRAME_TOO_LARGE: -32005,
  UNSUPPORTED_OPERATION: -32006,
  SESSION_BINDING_CONFLICT: -32007,
  SESSION_NOT_RUNNING: -32008,
  INTERACTION_NOT_PENDING: -32009,
  INVALID_CURSOR: -32010,
  SESSION_NOT_FOUND: -32011,
  SESSION_RUNNING: -32012,
  COMMAND_NOT_FOUND: -32013,
  INVALID_INTERACTION_RESPONSE: -32014,
  DSH_CONCURRENT_WRITER_DETECTED: -32015,
}

export class StdioTransport {
  private buffer = Buffer.alloc(0)
  private closed = false

  constructor(
    private readonly maxFrameBytes: number,
    private readonly dispatch: (request: JsonRpcRequest) => Promise<unknown>,
    private readonly onEof: () => void,
  ) {}

  start(): void {
    process.stdin.on('data', this.onData)
    process.stdin.once('end', this.onEnd)
    process.stdin.once('error', this.onEnd)
    process.stdin.resume()
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    process.stdin.off('data', this.onData)
    process.stdin.off('end', this.onEnd)
    process.stdin.off('error', this.onEnd)
    process.stdin.pause()
  }

  notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > this.maxFrameBytes && !this.buffer.includes(0x0a)) {
      this.write({ jsonrpc: '2.0', method: 'runtime.error', params: { code: 'FRAME_TOO_LARGE', message: 'incoming bridge frame exceeds configured limit' } })
      this.stop()
      this.onEof()
      return
    }
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline < 0) break
      const frame = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (frame.length === 0) continue
      if (frame.length > this.maxFrameBytes) {
        this.stop()
        this.onEof()
        return
      }
      void this.handle(frame)
    }
  }

  private readonly onEnd = (): void => {
    if (this.closed) return
    this.stop()
    this.onEof()
  }

  private async handle(frame: Buffer): Promise<void> {
    let value: unknown
    try {
      value = JSON.parse(frame.toString('utf8'))
      if (Array.isArray(value)) throw new RpcFault('INVALID_REQUEST', 'JSON-RPC batch is not supported')
      if (value === null || typeof value !== 'object') throw new RpcFault('INVALID_REQUEST', 'request must be an object')
      const request = value as Partial<JsonRpcRequest>
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.method.length === 0) {
        throw new RpcFault('INVALID_REQUEST', 'invalid JSON-RPC request')
      }
      const hasId = typeof request.id === 'string' || Number.isSafeInteger(request.id)
      if (request.id !== undefined && !hasId) throw new RpcFault('INVALID_REQUEST', 'request id must be a string or safe integer')
      const result = await this.dispatch(request as JsonRpcRequest)
      if (hasId) this.write({ jsonrpc: '2.0', id: request.id, result })
    } catch (error) {
      const id = value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as { id?: unknown }).id
        : null
      const fault = error instanceof RpcFault ? error : new RpcFault('INTERNAL_ERROR', 'DSH bridge request failed')
      this.write({
        jsonrpc: '2.0',
        id: typeof id === 'string' || Number.isSafeInteger(id) ? id : null,
        error: {
          code: ERROR_CODES[fault.code] ?? -32603,
          message: fault.message,
          data: {
            code: fault.code,
            retryable: fault.code === 'DSH_CONCURRENT_WRITER_DETECTED',
            ...(fault.details === undefined ? {} : { details: fault.details }),
          },
        },
      })
    }
  }

  private write(value: unknown): void {
    if (this.closed && (value as { method?: string }).method !== 'runtime.error') return
    const frame = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(frame) > this.maxFrameBytes) throw new Error('outgoing bridge frame exceeds configured limit')
    process.stdout.write(frame)
  }
}
