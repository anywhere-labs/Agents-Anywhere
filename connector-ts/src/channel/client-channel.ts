// 客户端安全通道（Desktop、CLI，以及测试；Web 换一个 NoiseCrypto 实现复用同一套逻辑）。
// 配对：XXpsk0，核对设备公钥与二维码一致；重连：KK，设备公钥是钉住的值。

import { clientIdFor } from '../domain/trust/index.js'
import { HandshakeState, type NoiseCrypto, type NoiseKeyPair } from './noise/index.js'
import {
  NOISE_PAIRING_PROTOCOL,
  NOISE_RECONNECT_PROTOCOL,
  b64url,
  connectPrologue,
  fromB64url,
  pairingPrologue,
} from './formats.js'
import {
  ChannelProtocolError,
  TransportSession,
  decodeHandshake,
  encodeHandshake,
  type ChannelItem,
  type ChannelWire,
} from './transport.js'

export interface PairingPayload {
  readonly v: 1
  readonly deviceId: string
  readonly deviceIdentityPub: string
  readonly pairingId: string
  readonly psk: string
  readonly serverUrl: string
  readonly e2eeMode: 'off' | 'required'
  readonly expiresAt: string
}

export interface DirectoryKeyGrant {
  readonly deviceId: string
  readonly keyId: string
  readonly epoch: number
  readonly key: string
}

export interface ChannelReady {
  readonly deviceId: string
  readonly clientId: string
  readonly directoryKeyId: string
  readonly directoryKeyEpoch: number
}

/** The channel failed or was closed; `code` is an AA error code (`e2ee_not_paired`, `pairing_expired`, …). */
export class ChannelClosedError extends Error {
  override readonly name = 'ChannelClosedError'
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message)
  }
}

export function parsePairingUri(uri: string): PairingPayload {
  const prefix = 'aa-pair://'
  if (!uri.startsWith(prefix)) throw new RangeError('not an aa-pair:// URI')
  const payload = JSON.parse(Buffer.from(uri.slice(prefix.length), 'base64url').toString('utf8')) as PairingPayload
  if (payload.v !== 1 || fromB64url(payload.deviceIdentityPub).length !== 32 || fromB64url(payload.psk).length !== 32) {
    throw new RangeError('malformed pairing payload')
  }
  return payload
}

interface Pending {
  resolve(value: { status: number; body: unknown }): void
  reject(error: Error): void
}

export interface ClientChannelOptions {
  readonly crypto: NoiseCrypto
  readonly identity: NoiseKeyPair
  readonly ch: string
  readonly wire: ChannelWire
  readonly now?: () => number
  /** Called as soon as the channel exists, before the handshake: route incoming items to `receive`/`ended`. */
  readonly bind?: (channel: ClientSecureChannel) => void
}

export class ClientSecureChannel {
  readonly clientId: string
  readonly deviceId: string
  readonly ch: string
  readonly #wire: ChannelWire
  #transport: TransportSession | null = null
  #inbox: ChannelItem[] = []
  #waiter: ((item: ChannelItem | null) => void) | null = null
  #closed: ChannelClosedError | null = null
  #ready: ChannelReady | null = null
  #committed: { grantedAt: string; directoryKey: DirectoryKeyGrant } | null = null
  #nextId = 1
  readonly #pending = new Map<string, Pending>()
  readonly #subscriptions = new Map<string, (event: Record<string, unknown>) => void>()
  readonly #channelEvents = new Set<(event: Record<string, unknown>) => void>()
  readonly #closeListeners = new Set<(error: ChannelClosedError) => void>()
  #pump: Promise<void> = Promise.resolve()

  private constructor(deviceId: string, options: ClientChannelOptions) {
    this.deviceId = deviceId
    this.clientId = clientIdFor(options.identity.publicKey)
    this.ch = options.ch
    this.#wire = options.wire
    options.bind?.(this)
  }

  /** First pairing from a scanned QR code. Resolves once the device committed the grant and sent `ready`. */
  static async pair(
    payload: PairingPayload,
    options: ClientChannelOptions & { readonly label: string; readonly platform: string },
  ): Promise<{ channel: ClientSecureChannel; grantedAt: string; directoryKey: DirectoryKeyGrant }> {
    const channel = new ClientSecureChannel(payload.deviceId, options)
    const hs = await HandshakeState.create({
      crypto: options.crypto,
      protocolName: NOISE_PAIRING_PROTOCOL,
      initiator: true,
      prologue: pairingPrologue(payload.deviceId, payload.pairingId, channel.clientId, options.ch),
      s: options.identity,
      psks: [fromB64url(payload.psk)],
    })
    const pattern = 'XXpsk0'
    await options.wire.send(
      encodeHandshake({ pattern, pairingId: payload.pairingId, step: 0, message: b64url(await hs.writeMessage()) }),
    )
    const reply = decodeHandshake(await channel.#nextItem(), 1)
    const hello = JSON.parse(Buffer.from(await hs.readMessage(fromB64url(reply.message))).toString('utf8')) as Record<string, unknown>
    // The device key in the handshake must be the one in the QR code, and the device must be the one we scanned.
    if (b64url(hs.remoteStatic!) !== payload.deviceIdentityPub || hello['deviceId'] !== payload.deviceId) {
      channel.#fail(new ChannelClosedError('device_pin_mismatch', 'the device key does not match the QR code'))
      throw channel.#closed!
    }
    const finish = await hs.writeMessage(Buffer.from(JSON.stringify({ label: options.label, platform: options.platform })))
    await options.wire.send(encodeHandshake({ pattern, pairingId: payload.pairingId, step: 2, message: b64url(finish) }))
    channel.#transport = new TransportSession(hs.takeTransport(), options.wire, options.now)
    await channel.#untilReady()
    const committed = channel.#committed
    if (!committed) throw new ChannelClosedError('e2ee_protocol_error', 'ready before pair.committed')
    return { channel, grantedAt: committed.grantedAt, directoryKey: committed.directoryKey }
  }

  /** Reconnect to a paired device; `devicePub` is the pinned key. */
  static async connect(deviceId: string, devicePub: Uint8Array, options: ClientChannelOptions): Promise<ClientSecureChannel> {
    const channel = new ClientSecureChannel(deviceId, options)
    const hs = await HandshakeState.create({
      crypto: options.crypto,
      protocolName: NOISE_RECONNECT_PROTOCOL,
      initiator: true,
      prologue: connectPrologue(deviceId, channel.clientId, options.ch),
      s: options.identity,
      rs: devicePub,
    })
    await options.wire.send(encodeHandshake({ pattern: 'KK', step: 0, message: b64url(await hs.writeMessage()) }))
    const reply = decodeHandshake(await channel.#nextItem(), 1)
    try {
      await hs.readMessage(fromB64url(reply.message))
    } catch {
      // Only the holder of the pinned device key can answer KK: anything else is a different device identity.
      channel.#fail(new ChannelClosedError('device_pin_mismatch', 'the device did not prove the pinned key'))
      throw channel.#closed!
    }
    channel.#transport = new TransportSession(hs.takeTransport(), options.wire, options.now)
    await channel.#untilReady()
    return channel
  }

  get ready(): ChannelReady {
    if (!this.#ready) throw new Error('channel not ready')
    return this.#ready
  }

  get closed(): ChannelClosedError | null {
    return this.#closed
  }

  /** Feed one item from the wire (tunnel WebSocket). */
  receive(item: ChannelItem): void {
    if (this.#closed) return
    if (this.#waiter) {
      const waiter = this.#waiter
      this.#waiter = null
      waiter(item)
    } else {
      this.#inbox.push(item)
    }
  }

  /** The Server ended the tunnel (ClientTunnelEnd) or the WebSocket closed. */
  ended(code: string): void {
    this.#fail(new ChannelClosedError(code))
  }

  onChannelEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.#channelEvents.add(listener)
    return () => this.#channelEvents.delete(listener)
  }

  onClose(listener: (error: ChannelClosedError) => void): void {
    this.#closeListeners.add(listener)
  }

  async request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown = null): Promise<{ status: number; body: unknown }> {
    const transport = this.#requireOpen()
    const id = `r${this.#nextId++}`
    const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => this.#pending.set(id, { resolve, reject }))
    await transport.sendMessage({ kind: 'request', id, method, path, body })
    return response
  }

  async subscribe(sessionId: string, afterCursor: string | null, onEvent: (event: Record<string, unknown>) => void): Promise<string> {
    const transport = this.#requireOpen()
    const id = `s${this.#nextId++}`
    this.#subscriptions.set(id, onEvent)
    await transport.sendMessage({ kind: 'subscribe', id, stream: 'session', sessionId, afterCursor })
    return id
  }

  async unsubscribe(id: string): Promise<void> {
    this.#subscriptions.delete(id)
    await this.#transport?.sendMessage({ kind: 'unsubscribe', id })
  }

  rekeyNow(): Promise<void> {
    return this.#requireOpen().rekeyNow()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    await this.#transport?.sendMessage({ kind: 'close', reason: 'shutdown', message: '' }).catch(() => undefined)
    this.#fail(new ChannelClosedError('closed'))
    this.#wire.end('closed')
  }

  #requireOpen(): TransportSession {
    if (this.#closed) throw this.#closed
    if (!this.#transport || !this.#ready) throw new Error('channel not ready')
    return this.#transport
  }

  #nextItem(): Promise<ChannelItem> {
    if (this.#closed) return Promise.reject(this.#closed)
    const queued = this.#inbox.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      this.#waiter = (item) => (item ? resolve(item) : reject(this.#closed))
    })
  }

  /** Runs the receive loop until `ready`, then keeps it running in the background. */
  async #untilReady(): Promise<void> {
    while (!this.#ready) {
      const item = await this.#nextItem()
      try {
        await this.#process(item)
      } catch (error) {
        const closed = error instanceof ChannelClosedError ? error : new ChannelClosedError('e2ee_protocol_error', (error as Error).message)
        this.#fail(closed)
        this.#wire.end(closed.code)
        throw closed
      }
    }
    this.#pump = this.#loop()
  }

  async #loop(): Promise<void> {
    while (!this.#closed) {
      let item: ChannelItem
      try {
        item = await this.#nextItem()
      } catch {
        return
      }
      try {
        await this.#process(item)
      } catch (error) {
        this.#fail(error instanceof ChannelClosedError ? error : new ChannelClosedError('e2ee_protocol_error', (error as Error).message))
        this.#wire.end('e2ee_protocol_error')
        return
      }
    }
  }

  async #process(item: ChannelItem): Promise<void> {
    let messages: unknown[]
    try {
      messages = await this.#transport!.receive(item)
    } catch (error) {
      if (error instanceof ChannelProtocolError) throw new ChannelClosedError(error.code, error.message)
      throw error
    }
    for (const raw of messages) {
      const message = raw as Record<string, unknown>
      switch (message['kind']) {
        case 'pair.committed':
          this.#committed = {
            grantedAt: String(message['grantedAt']),
            directoryKey: message['directoryKey'] as DirectoryKeyGrant,
          }
          break
        case 'ready':
          if (message['clientId'] !== this.clientId || message['deviceId'] !== this.deviceId) {
            throw new ChannelClosedError('e2ee_protocol_error', 'ready names another client or device')
          }
          this.#ready = message as unknown as ChannelReady
          break
        case 'response': {
          const id = String(message['id'])
          this.#pending.get(id)?.resolve({ status: Number(message['status']), body: message['body'] })
          this.#pending.delete(id)
          break
        }
        case 'event': {
          const event = message['event'] as Record<string, unknown>
          const sub = message['sub']
          if (typeof sub === 'string') this.#subscriptions.get(sub)?.(event)
          else for (const listener of this.#channelEvents) listener(event)
          break
        }
        case 'close':
          throw new ChannelClosedError(String(message['message'] || message['reason']), String(message['reason']))
        default:
          throw new ChannelClosedError('e2ee_protocol_error', `unexpected message ${String(message['kind'])}`)
      }
    }
  }

  #fail(error: ChannelClosedError): void {
    if (this.#closed) return
    this.#closed = error
    this.#transport?.destroy()
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    if (this.#waiter) {
      const waiter = this.#waiter
      this.#waiter = null
      waiter(null)
    }
    for (const listener of this.#closeListeners) listener(error)
  }

  /** For tests: resolves when the background loop stops. */
  get stopped(): Promise<void> {
    return this.#pump
  }
}
