// The client side of a secure channel (contracts/e2ee/1.0). Pairing: XXpsk0, the device key must equal the QR
// code's. Reconnect: KK against the pinned device key. Port of connector-ts/src/channel/client-channel.ts.

import { b64url, fromB64url, fromUtf8, utf8 } from "../../../src/lib/e2ee/bytes"
import { NOISE_PAIRING_PROTOCOL, NOISE_RECONNECT_PROTOCOL, clientIdFor, connectPrologue, pairingPrologue } from "../../../src/lib/e2ee/formats"
import { HandshakeState, type NoiseCrypto, type NoiseKeyPair } from "./noise"
import {
  ChannelProtocolError,
  TransportSession,
  decodeHandshake,
  encodeHandshake,
  type ChannelItem,
  type ChannelWire,
} from "./transport"

import {
  ChannelClosedError, type ChannelMethod, type ChannelReady, type DirectoryKeyGrant, type PairingPayload,
  type SubscribeTarget,
} from "../../../src/lib/e2ee/content-channel"

export { parsePairingUri, ChannelClosedError } from "../../../src/lib/e2ee/content-channel"
export type { DirectoryKeyGrant, PairingPayload } from "../../../src/lib/e2ee/content-channel"

/** `ChannelClose.reason` -> the AA code clients act on. */
const CLOSE_REASON_CODES: Readonly<Record<string, string>> = {
  not_paired: "e2ee_not_paired",
  revoked: "e2ee_not_paired",
  protocol_error: "e2ee_protocol_error",
  too_large: "too_large",
  policy: "e2ee_required",
  shutdown: "closed",
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

  private constructor(deviceId: string, clientId: string, options: ClientChannelOptions) {
    this.deviceId = deviceId
    this.clientId = clientId
    this.ch = options.ch
    this.#wire = options.wire
    options.bind?.(this)
  }

  /** First pairing from a scanned QR code. Resolves once the device committed the grant and sent `ready`. */
  static async pair(
    payload: PairingPayload,
    options: ClientChannelOptions & { readonly label: string; readonly platform: string },
  ): Promise<{ channel: ClientSecureChannel; grantedAt: string; directoryKey: DirectoryKeyGrant }> {
    const channel = new ClientSecureChannel(payload.deviceId, await clientIdFor(options.identity.publicKey), options)
    try {
      const hs = await HandshakeState.create({
        crypto: options.crypto,
        protocolName: NOISE_PAIRING_PROTOCOL,
        initiator: true,
        prologue: pairingPrologue(payload.deviceId, payload.pairingId, channel.clientId, options.ch),
        s: options.identity,
        psks: [fromB64url(payload.psk)],
      })
      const pattern = "XXpsk0"
      await options.wire.send(encodeHandshake({ pattern, pairingId: payload.pairingId, step: 0, message: b64url(await hs.writeMessage()) }))
      const reply = decodeHandshake(await channel.#nextItem(), 1)
      let hello: Record<string, unknown>
      try {
        hello = JSON.parse(fromUtf8(await hs.readMessage(fromB64url(reply.message)))) as Record<string, unknown>
      } catch {
        // A wrong psk (expired or re-issued QR code) fails here.
        throw new ChannelClosedError("pairing_expired", "the device did not accept this pairing code")
      }
      // The device key in the handshake must be the one in the QR code, and the device must be the one we scanned.
      if (b64url(hs.remoteStatic!) !== payload.deviceIdentityPub || hello["deviceId"] !== payload.deviceId)
        throw new ChannelClosedError("device_pin_mismatch", "the device key does not match the QR code")
      const finish = await hs.writeMessage(utf8(JSON.stringify({ label: options.label, platform: options.platform })))
      await options.wire.send(encodeHandshake({ pattern, pairingId: payload.pairingId, step: 2, message: b64url(finish) }))
      channel.#transport = new TransportSession(hs.takeTransport(), options.wire, options.now)
    } catch (error) {
      throw channel.#abort(error)
    }
    await channel.#untilReady()
    const committed = channel.#committed
    if (!committed) throw channel.#abort(new ChannelClosedError("e2ee_protocol_error", "ready before pair.committed"))
    return { channel, grantedAt: committed.grantedAt, directoryKey: committed.directoryKey }
  }

  /** Reconnect to a paired device; `devicePub` is the pinned key. */
  static async connect(deviceId: string, devicePub: Uint8Array, options: ClientChannelOptions): Promise<ClientSecureChannel> {
    const channel = new ClientSecureChannel(deviceId, await clientIdFor(options.identity.publicKey), options)
    try {
      const hs = await HandshakeState.create({
        crypto: options.crypto,
        protocolName: NOISE_RECONNECT_PROTOCOL,
        initiator: true,
        prologue: connectPrologue(deviceId, channel.clientId, options.ch),
        s: options.identity,
        rs: devicePub,
      })
      await options.wire.send(encodeHandshake({ pattern: "KK", step: 0, message: b64url(await hs.writeMessage()) }))
      const reply = decodeHandshake(await channel.#nextItem(), 1)
      try {
        await hs.readMessage(fromB64url(reply.message))
      } catch {
        // Only the holder of the pinned device key can answer KK: anything else is a different device identity.
        throw new ChannelClosedError("device_pin_mismatch", "the device did not prove the pinned key")
      }
      channel.#transport = new TransportSession(hs.takeTransport(), options.wire, options.now)
    } catch (error) {
      throw channel.#abort(error)
    }
    await channel.#untilReady()
    return channel
  }

  get ready(): ChannelReady {
    if (!this.#ready) throw new Error("channel not ready")
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
    } else this.#inbox.push(item)
  }

  /** The Server ended the tunnel (ClientTunnelEnd) or the WebSocket closed. */
  ended(code: string): void {
    this.#fail(new ChannelClosedError(code))
  }

  onChannelEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.#channelEvents.add(listener)
    return () => this.#channelEvents.delete(listener)
  }

  onClose(listener: (error: ChannelClosedError) => void): () => void {
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  async request(method: ChannelMethod, path: string, body: unknown = null): Promise<{ status: number; body: unknown }> {
    const transport = this.#requireOpen()
    const id = `r${this.#nextId++}`
    const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => this.#pending.set(id, { resolve, reject }))
    try {
      await transport.sendMessage({ kind: "request", id, method, path, body })
    } catch (error) {
      this.#pending.delete(id)
      throw error
    }
    return response
  }

  /** Opens a stream (`TunnelSubscribe`): a session's events, or a device terminal's WebSocket messages. */
  async subscribe(target: SubscribeTarget, onEvent: (event: Record<string, unknown>) => void): Promise<string> {
    const transport = this.#requireOpen()
    const id = `s${this.#nextId++}`
    this.#subscriptions.set(id, onEvent)
    const message =
      target.stream === "terminal"
        ? { kind: "subscribe", id, stream: "terminal", terminalId: target.terminalId }
        : { kind: "subscribe", id, stream: "session", sessionId: target.sessionId, afterCursor: target.afterCursor ?? null }
    try {
      await transport.sendMessage(message)
    } catch (error) {
      this.#subscriptions.delete(id)
      throw error
    }
    return id
  }

  async unsubscribe(id: string): Promise<void> {
    if (!this.#subscriptions.delete(id) || this.#closed) return
    await this.#transport?.sendMessage({ kind: "unsubscribe", id })
  }

  rekeyNow(): Promise<void> {
    return this.#requireOpen().rekeyNow()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    await this.#transport?.sendMessage({ kind: "close", reason: "shutdown", message: "" }).catch(() => undefined)
    this.#fail(new ChannelClosedError("closed"))
    this.#wire.end("closed")
  }

  /** For tests: resolves when the background loop stops. */
  get stopped(): Promise<void> {
    return this.#pump
  }

  #requireOpen(): TransportSession {
    if (this.#closed) throw this.#closed
    if (!this.#transport || !this.#ready) throw new Error("channel not ready")
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

  #abort(error: unknown): ChannelClosedError {
    const closed =
      error instanceof ChannelClosedError
        ? error
        : error instanceof ChannelProtocolError
          ? new ChannelClosedError(error.code, error.message)
          : new ChannelClosedError("e2ee_handshake_failed", (error as Error)?.message)
    const wasOpen = !this.#closed
    this.#fail(closed)
    if (wasOpen) this.#wire.end(closed.code)
    return this.#closed!
  }

  /** Runs the receive loop until `ready`, then keeps it running in the background. */
  async #untilReady(): Promise<void> {
    while (!this.#ready) {
      let item: ChannelItem
      try {
        item = await this.#nextItem()
        await this.#process(item)
      } catch (error) {
        throw this.#abort(error)
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
        this.#abort(error)
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
      switch (message["kind"]) {
        case "pair.committed":
          this.#committed = { grantedAt: String(message["grantedAt"]), directoryKey: message["directoryKey"] as DirectoryKeyGrant }
          break
        case "ready":
          if (message["clientId"] !== this.clientId || message["deviceId"] !== this.deviceId)
            throw new ChannelClosedError("e2ee_protocol_error", "ready names another client or device")
          this.#ready = message as unknown as ChannelReady
          break
        case "response": {
          const id = String(message["id"])
          this.#pending.get(id)?.resolve({ status: Number(message["status"]), body: message["body"] })
          this.#pending.delete(id)
          break
        }
        case "event": {
          const event = message["event"] as Record<string, unknown>
          const sub = message["sub"]
          if (typeof sub === "string") this.#subscriptions.get(sub)?.(event)
          else for (const listener of this.#channelEvents) listener(event)
          break
        }
        case "close": {
          const reason = String(message["reason"])
          throw new ChannelClosedError(CLOSE_REASON_CODES[reason] ?? "closed", String(message["message"] || reason), true)
        }
        default:
          throw new ChannelClosedError("e2ee_protocol_error", `unexpected message ${String(message["kind"])}`)
      }
    }
  }

  #fail(error: ChannelClosedError): void {
    if (this.#closed) return
    this.#closed = error
    this.#transport?.destroy()
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.#subscriptions.clear()
    if (this.#waiter) {
      const waiter = this.#waiter
      this.#waiter = null
      waiter(null)
    }
    for (const listener of this.#closeListeners) listener(error)
  }
}
