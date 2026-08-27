import { once } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { BridgeError, publicError } from './errors.js'
import type { InboundFrame, JsonRpcFailure, JsonRpcId, JsonRpcRequest, JsonRpcSuccess } from './types.js'
import { isRecord, validateInboundFrame } from './validation.js'

/** Callbacks owned by the bridge dispatcher. */
export interface TransportHandler {
  request(frame: JsonRpcRequest): Promise<unknown>
  notification(frame: Exclude<InboundFrame, JsonRpcRequest>): Promise<void>
  eof(): Promise<void>
  fatal(error: BridgeError): Promise<void>
}

/** Bounded NDJSON JSON-RPC transport over a child process's stdio. */
export class StdioJsonRpcTransport {
  private buffered = Buffer.alloc(0)
  private started = false
  private stopped = false
  private writeTail: Promise<void> = Promise.resolve()

  /**
   * Create the transport without claiming stdin yet.
   * @param input - Protocol input stream.
   * @param output - Protocol-only output stream.
   * @param maxFrameBytes - Maximum bytes before LF.
   * @param handler - Dispatcher and lifecycle callbacks.
   */
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly maxFrameBytes: number,
    private readonly handler: TransportHandler,
  ) {}

  /** Start the single stdin reader owned by this transport. */
  start(): void {
    if (this.started) throw new Error('stdio transport already started')
    this.started = true
    this.input.on('data', this.onData)
    this.input.once('end', this.onEnd)
    this.input.once('error', this.onInputError)
  }

  /** Stop accepting input while preserving output for the final response. */
  stopInput(): void {
    if (this.stopped) return
    this.stopped = true
    this.input.off('data', this.onData)
    this.input.off('end', this.onEnd)
    this.input.off('error', this.onInputError)
    this.input.pause()
  }

  /** Send a protocol notification with serialized stdout backpressure. */
  notify(method: string, params: Record<string, unknown>): Promise<void> {
    return this.enqueue({ jsonrpc: '2.0', method, params })
  }

  /** Wait until all accepted protocol frames have reached stdout. */
  async flush(): Promise<void> {
    await this.writeTail
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.stopped) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    this.buffered = Buffer.concat([this.buffered, bytes])
    this.consumeLines()
  }

  private readonly onEnd = (): void => {
    if (this.stopped) return
    if (this.buffered.length > 0) {
      this.buffered = Buffer.alloc(0)
      void this.failFatal(new BridgeError('INVALID_REQUEST', 'The final protocol frame was not terminated by LF.', { retryable: false }))
      return
    }
    this.buffered = Buffer.alloc(0)
    void this.handler.eof()
  }

  private readonly onInputError = (): void => {
    void this.failFatal(new BridgeError('INTERNAL_ERROR', 'The bridge input stream failed.', { retryable: false }))
  }

  private consumeLines(): void {
    let newline = this.buffered.indexOf(0x0a)
    while (newline !== -1) {
      let line = this.buffered.subarray(0, newline)
      this.buffered = this.buffered.subarray(newline + 1)
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
      if (line.length > this.maxFrameBytes) {
        void this.failFatal(new BridgeError('FRAME_TOO_LARGE', 'Inbound frame exceeded the configured byte limit.', { retryable: false }))
        return
      }
      this.acceptLine(line)
      if (this.stopped) return
      newline = this.buffered.indexOf(0x0a)
    }
    if (this.buffered.length > this.maxFrameBytes) {
      void this.failFatal(new BridgeError('FRAME_TOO_LARGE', 'Inbound frame exceeded the configured byte limit.', { retryable: false }))
    }
  }

  private acceptLine(bytes: Buffer): void {
    if (bytes.length === 0) {
      this.rejectFrame(null, new BridgeError('INVALID_REQUEST', 'Empty protocol frames are not allowed.', { retryable: false }))
      return
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      this.rejectFrame(null, new BridgeError('INVALID_REQUEST', 'A UTF-8 BOM is not allowed.', { retryable: false }))
      return
    }
    let line: string
    try {
      line = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      this.rejectFrame(null, new BridgeError('PARSE_ERROR', 'Frame is not valid UTF-8.', { retryable: false }))
      return
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(line) as unknown
    } catch {
      this.rejectFrame(null, new BridgeError('PARSE_ERROR', 'Invalid JSON.', { retryable: false }))
      return
    }
    let frame: InboundFrame
    try {
      frame = validateInboundFrame(decoded)
    } catch (error: unknown) {
      this.rejectFrame(errorId(decoded), publicError(error))
      return
    }
    if ('id' in frame) {
      void this.dispatchRequest(frame).catch(() => this.failFatal(
        new BridgeError('INTERNAL_ERROR', 'The bridge output stream failed.', { retryable: false }),
      ))
    } else {
      void this.handler.notification(frame).catch(error => this.reportNotificationFailure(frame.method, error))
    }
  }

  private async dispatchRequest(frame: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.handler.request(frame)
      const response: JsonRpcSuccess = { jsonrpc: '2.0', id: frame.id, result }
      await this.enqueue(response)
    } catch (error: unknown) {
      const exposed = publicError(error)
      if (exposed.data.code === 'FRAME_TOO_LARGE') {
        await this.failFatal(exposed)
        return
      }
      await this.sendFailure(frame.id, exposed)
    }
  }

  private reportNotificationFailure(method: string, error: unknown): void {
    const message = error instanceof BridgeError ? error.data.code : 'INTERNAL_ERROR'
    process.stderr.write(`[aa-dsh-bridge] notification ${method} failed: ${message}\n`)
  }

  private sendFailure(id: JsonRpcId | null, error: BridgeError): Promise<void> {
    const response: JsonRpcFailure = {
      jsonrpc: '2.0',
      id,
      error: { code: error.rpcCode, message: error.message, data: { ...error.data } },
    }
    return this.enqueue(response)
  }

  private rejectFrame(id: JsonRpcId | null, error: BridgeError): void {
    void this.sendFailure(id, error).catch(() => this.failFatal(
      new BridgeError('INTERNAL_ERROR', 'The bridge output stream failed.', { retryable: false }),
    ))
  }

  private enqueue(frame: unknown): Promise<void> {
    const line = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(line) > this.maxFrameBytes + 1) {
      return Promise.reject(new BridgeError('FRAME_TOO_LARGE', 'Outbound frame exceeded the configured byte limit.', { retryable: false }))
    }
    this.writeTail = this.writeTail.then(async () => {
      if (!this.output.write(line)) await once(this.output, 'drain')
    })
    return this.writeTail
  }

  private async failFatal(error: BridgeError): Promise<void> {
    this.stopInput()
    await this.handler.fatal(error)
  }
}

function errorId(value: unknown): JsonRpcId | null {
  if (!isRecord(value)) return null
  const id = value.id
  if ((typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isSafeInteger(id))) return id
  return null
}
