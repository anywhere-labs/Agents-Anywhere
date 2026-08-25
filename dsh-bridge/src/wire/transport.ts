import { once } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { BridgeError, publicError } from './errors.js'
import { MAX_FRAME_BYTES } from './protocol.js'
import type {
  InboundFrame,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccess,
} from './types.js'
import { isRecord, validateInboundFrame } from './validation.js'

export interface TransportHandler {
  request(frame: JsonRpcRequest): Promise<unknown>
  notification(frame: Exclude<InboundFrame, JsonRpcRequest>): Promise<void>
  eof(): Promise<void>
  fatal(error: BridgeError): Promise<void>
}

export class NdjsonTransport {
  private buffered = Buffer.alloc(0)
  private started = false
  private stopped = false
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handler: TransportHandler,
  ) {}

  start(): void {
    if (this.started) throw new Error('transport is already started')
    this.started = true
    this.input.on('data', this.onData)
    this.input.once('end', this.onEnd)
    this.input.once('error', this.onInputError)
  }

  stopInput(): void {
    if (this.stopped) return
    this.stopped = true
    this.input.off('data', this.onData)
    this.input.off('end', this.onEnd)
    this.input.off('error', this.onInputError)
    this.input.pause()
  }

  notify(method: string, params: Record<string, unknown>): Promise<void> {
    return this.enqueue({ jsonrpc: '2.0', method, params })
  }

  async flush(): Promise<void> {
    await this.writeTail
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.stopped) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    if (this.buffered.length + bytes.length > MAX_FRAME_BYTES + 1) {
      void this.failFatal(new BridgeError('INVALID_REQUEST', 'Inbound frame exceeded 8 MiB.', {
        retryable: false,
        details: { code: 'FRAME_TOO_LARGE' },
      }))
      return
    }
    this.buffered = Buffer.concat([this.buffered, bytes])
    this.consumeLines()
  }

  private readonly onEnd = (): void => {
    if (this.stopped) return
    if (this.buffered.length > 0) {
      void this.failFatal(new BridgeError('INVALID_REQUEST', 'Final frame was not LF terminated.', { retryable: false }))
      return
    }
    void this.handler.eof()
  }

  private readonly onInputError = (): void => {
    void this.failFatal(new BridgeError('INTERNAL_ERROR', 'Bridge input failed.', { retryable: false }))
  }

  private consumeLines(): void {
    let newline = this.buffered.indexOf(0x0a)
    while (newline !== -1) {
      let line = this.buffered.subarray(0, newline)
      this.buffered = this.buffered.subarray(newline + 1)
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
      if (line.length > MAX_FRAME_BYTES) {
        void this.failFatal(new BridgeError('INVALID_REQUEST', 'Inbound frame exceeded 8 MiB.', {
          retryable: false,
          details: { code: 'FRAME_TOO_LARGE' },
        }))
        return
      }
      this.acceptLine(line)
      if (this.stopped) return
      newline = this.buffered.indexOf(0x0a)
    }
  }

  private acceptLine(bytes: Buffer): void {
    if (bytes.length === 0) {
      void this.failFatal(new BridgeError('INVALID_REQUEST', 'Empty protocol frames are not allowed.', { retryable: false }))
      return
    }
    let decoded: unknown
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      decoded = JSON.parse(text) as unknown
    } catch (error: unknown) {
      void this.failFatal(new BridgeError('PARSE_ERROR', 'Frame is not valid UTF-8 JSON.', { retryable: false }, { cause: error }))
      return
    }
    let frame: InboundFrame
    try {
      frame = validateInboundFrame(decoded)
    } catch (error: unknown) {
      const exposed = publicError(error)
      const id = errorId(decoded)
      if (id === undefined) {
        void this.failFatal(exposed)
        return
      }
      void this.sendFailure(id, exposed)
      return
    }
    if ('id' in frame) {
      void this.dispatchRequest(frame)
      return
    }
    void this.handler.notification(frame).catch(error => this.handler.fatal(publicError(error)))
  }

  private async dispatchRequest(frame: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.handler.request(frame)
      const response: JsonRpcSuccess = { jsonrpc: '2.0', id: frame.id, result }
      await this.enqueue(response)
    } catch (error: unknown) {
      await this.sendFailure(frame.id, publicError(error))
    }
  }

  private sendFailure(id: JsonRpcId, error: BridgeError): Promise<void> {
    const response: JsonRpcFailure = {
      jsonrpc: '2.0',
      id,
      error: { code: error.rpcCode, message: error.message, data: { ...error.data } },
    }
    return this.enqueue(response)
  }

  private enqueue(frame: unknown): Promise<void> {
    const line = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES + 1) {
      return Promise.reject(new BridgeError('INTERNAL_ERROR', 'Outbound frame exceeded 8 MiB.', {
        retryable: false,
        details: { code: 'FRAME_TOO_LARGE' },
      }))
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

function errorId(value: unknown): JsonRpcId | undefined {
  if (!isRecord(value)) return undefined
  const id = value.id
  if ((typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isSafeInteger(id))) {
    return id
  }
  return undefined
}
