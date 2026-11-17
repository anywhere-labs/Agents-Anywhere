// Transport layer after the handshake: fragmentation, reassembly, rekey by frame count/time, nonce checks. Shared by device and client.

import { NoiseError, type CipherState, type TransportPair } from './noise/index.js'
import {
  FRAME_REKEY,
  REKEY_INTERVAL_FRAMES,
  REKEY_INTERVAL_MS,
  Reassembler,
  b64url,
  fragment,
  fromB64url,
} from './formats.js'

/** One `{n, ct}` item: `SecureChannelItem` towards the device, the body of a `ClientTunnelFrame` towards a client. */
export interface ChannelItem {
  readonly n: number
  readonly ct: string
}

/** The pipe a channel writes to: the MeshCall duplex call on the device, the tunnel WebSocket on a client. */
export interface ChannelWire {
  send(item: ChannelItem): void | Promise<void>
  /** End the channel; `code` travels as the MeshCall error code / `ClientTunnelEnd.code`. */
  end(code?: string): void
}

/** The other side broke the protocol (bad nonce, bad frame, failed MAC): the channel must close. */
export class ChannelProtocolError extends Error {
  override readonly name = 'ChannelProtocolError'
  constructor(
    message: string,
    readonly code = 'e2ee_protocol_error',
  ) {
    super(message)
  }
}

const EMPTY = new Uint8Array(0)

export class TransportSession {
  readonly #send: CipherState
  readonly #receive: CipherState
  readonly #wire: ChannelWire
  readonly #now: () => number
  readonly #reassembler = new Reassembler()
  #sendQueue: Promise<void> = Promise.resolve()
  #framesSinceRekey = 0
  #lastRekeyMs: number

  constructor(pair: TransportPair, wire: ChannelWire, now: () => number = Date.now) {
    this.#send = pair.send
    this.#receive = pair.receive
    this.#wire = wire
    this.#now = now
    this.#lastRekeyMs = now()
  }

  /** Encrypt and send one channel message (JSON), fragmenting it; rekeys first when the interval is due. */
  sendMessage(message: unknown): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(message), 'utf8')
    const run = this.#sendQueue.then(async () => {
      // Rekey only between messages: a rekey frame inside a message is a protocol error for the receiver. The
      // frame counter may overshoot the interval by one message (at most 257 frames), which is harmless.
      if (this.#framesSinceRekey >= REKEY_INTERVAL_FRAMES || this.#now() - this.#lastRekeyMs >= REKEY_INTERVAL_MS) {
        await this.#writeFrame(Uint8Array.of(FRAME_REKEY))
        await this.#send.rekey()
        this.#framesSinceRekey = 0
        this.#lastRekeyMs = this.#now()
      }
      for (const frame of fragment(bytes)) {
        await this.#writeFrame(frame)
        this.#framesSinceRekey += 1
      }
    })
    this.#sendQueue = run.catch(() => undefined)
    return run
  }

  /** Force a rekey of the send direction now (tests, or after a suspected key exposure). */
  rekeyNow(): Promise<void> {
    const run = this.#sendQueue.then(async () => {
      await this.#writeFrame(Uint8Array.of(FRAME_REKEY))
      await this.#send.rekey()
      this.#framesSinceRekey = 0
      this.#lastRekeyMs = this.#now()
    })
    this.#sendQueue = run.catch(() => undefined)
    return run
  }

  /** Decrypt one received item; returns the complete messages it finished (zero or one). */
  async receive(item: ChannelItem): Promise<unknown[]> {
    if (BigInt(item.n) !== this.#receive.nonce) {
      throw new ChannelProtocolError(`unexpected frame counter ${item.n}, expected ${this.#receive.nonce}`)
    }
    let plaintext: Uint8Array
    try {
      plaintext = await this.#receive.decryptWithAd(EMPTY, fromB64url(item.ct))
    } catch (error) {
      if (error instanceof NoiseError) throw new ChannelProtocolError('frame failed to decrypt')
      throw error
    }
    let result
    try {
      result = this.#reassembler.push(plaintext)
    } catch (error) {
      throw new ChannelProtocolError((error as Error).message, /too large/.test((error as Error).message) ? 'too_large' : 'e2ee_protocol_error')
    }
    if (!result) return []
    if (result.kind === 'rekey') {
      await this.#receive.rekey()
      return []
    }
    try {
      return [JSON.parse(Buffer.from(result.bytes).toString('utf8'))]
    } catch {
      throw new ChannelProtocolError('channel message is not JSON')
    }
  }

  destroy(): void {
    this.#send.destroy()
    this.#receive.destroy()
  }

  async #writeFrame(plaintext: Uint8Array): Promise<void> {
    const n = Number(this.#send.nonce)
    const ct = await this.#send.encryptWithAd(EMPTY, plaintext)
    await this.#wire.send({ n, ct: b64url(ct) })
  }
}

export interface HandshakeEnvelope {
  readonly pattern: 'XXpsk0' | 'KK'
  readonly pairingId?: string | null
  readonly step: number
  readonly message: string
}

export function encodeHandshake(envelope: HandshakeEnvelope): ChannelItem {
  return { n: envelope.step, ct: b64url(Buffer.from(JSON.stringify(envelope), 'utf8')) }
}

export function decodeHandshake(item: ChannelItem, expectedStep: number): HandshakeEnvelope {
  let envelope: HandshakeEnvelope
  try {
    envelope = JSON.parse(Buffer.from(item.ct, 'base64url').toString('utf8')) as HandshakeEnvelope
  } catch {
    throw new ChannelProtocolError('handshake frame is not a HandshakeEnvelope')
  }
  if (
    item.n !== expectedStep ||
    envelope.step !== expectedStep ||
    (envelope.pattern !== 'XXpsk0' && envelope.pattern !== 'KK') ||
    typeof envelope.message !== 'string'
  ) {
    throw new ChannelProtocolError('unexpected handshake frame')
  }
  return envelope
}
