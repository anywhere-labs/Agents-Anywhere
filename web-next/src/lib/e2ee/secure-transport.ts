// Encrypted session content (docs/v3/11-e2ee-noise.md §10): implements the transport adapter's
// `SessionContentTransport` over one secure channel per device. Requests become `TunnelRequest`s, the session
// stream a `TunnelSubscribe`; commands are registered with the Server first (`POST /api/v3/e2ee/commands`).

import { ApiError, apiErrorKind } from "@/lib/api/errors"
import {
  isContentTransportRequired,
  reportContentTransportRequired,
  type ContentRequest,
  type SessionContentTransport,
  type SessionEventStream,
} from "@/lib/transport/content-transport"
import { b64url, fromB64url, utf8 } from "./bytes"
import {
  ChannelClosedError,
  ClientSecureChannel,
  type ChannelMethod,
  type DirectoryKeyGrant,
  type PairingPayload,
} from "./client-channel"
import { inputDigest } from "./formats"
import type { NoiseCrypto } from "./noise"
import type { ClientTrustStore, DevicePin } from "./trust-store"
import type { TunnelMux } from "./tunnel"
import { randomBytes } from "./webcrypto"

export interface CommandRegistrationView {
  readonly commandId: string
  readonly outcome: "accepted" | "rejected" | null
  readonly errorCode: string | null
  readonly duplicate: boolean
}

export interface SecureTransportDeps {
  readonly store: ClientTrustStore
  readonly mux: TunnelMux
  readonly crypto: NoiseCrypto
  readonly label: string
  readonly platform: "web" | "desktop"
  /** `POST /api/v3/e2ee/commands`. */
  registerCommand(registration: { commandId: string; deviceId: string; inputDigest: string }): Promise<CommandRegistrationView>
  /** Plaintext session metadata: which device holds the session (`GET /api/v2/sessions/{id}/meta`). */
  deviceOfSession(sessionId: string): Promise<string>
  /** Already known from the session list (no request needed). */
  knownDevice?(sessionId: string): string | undefined
}

const notPaired = (deviceId: string) =>
  new ApiError({ status: 409, kind: "http", code: "e2ee_not_paired", detail: `Pair this client with device ${deviceId} first.` })

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof ChannelClosedError) {
    const status = error.code === "connector_offline" ? 503 : 409
    return new ApiError({ status, kind: apiErrorKind(status), code: error.code, detail: error.message })
  }
  return new ApiError({ status: 0, kind: "network", detail: (error as Error)?.message ?? "secure channel failed" })
}

function newChannelId(): string {
  return `c_${b64url(randomBytes(12))}`
}

/** One secure channel per paired device, opened on demand (KK) and shared by every session of that device. */
export class SecureChannelPool {
  readonly #deps: SecureTransportDeps
  readonly #channels = new Map<string, Promise<ClientSecureChannel>>()
  readonly #sessionDevices = new Map<string, string>()

  constructor(deps: SecureTransportDeps) {
    this.#deps = deps
  }

  /** First pairing from a QR code / `aa-pair://` link. Keeps the new channel open for use. */
  async pair(payload: PairingPayload, deviceLabel?: string): Promise<DevicePin> {
    const identity = await this.#deps.store.identity()
    const ch = newChannelId()
    let channel: ClientSecureChannel | null = null
    const wire = this.#deps.mux.wire({ deviceId: payload.deviceId, clientId: identity.clientId, ch }, {
      receive: (item) => channel?.receive(item),
      ended: (code) => channel?.ended(code),
    })
    const result = await ClientSecureChannel.pair(payload, {
      crypto: this.#deps.crypto,
      identity: identity.noise,
      ch,
      wire,
      label: this.#deps.label,
      platform: this.#deps.platform,
      bind: (value) => {
        channel = value
      },
    })
    const pin = await this.#deps.store.savePairing({
      deviceId: payload.deviceId,
      devicePub: payload.deviceIdentityPub,
      label: deviceLabel || payload.deviceId,
      grantedAt: result.grantedAt,
      directoryKey: result.directoryKey,
    })
    this.#adopt(payload.deviceId, result.channel)
    this.#channels.set(payload.deviceId, Promise.resolve(result.channel))
    return pin
  }

  /** The open channel to `deviceId`, reconnecting with KK when needed. */
  channel(deviceId: string): Promise<ClientSecureChannel> {
    let pending = this.#channels.get(deviceId)
    if (!pending) {
      pending = this.#connect(deviceId)
      this.#channels.set(deviceId, pending)
      pending.catch(() => {
        if (this.#channels.get(deviceId) === pending) this.#channels.delete(deviceId)
      })
    }
    return pending
  }

  async deviceOf(sessionId: string): Promise<string> {
    const known = this.#sessionDevices.get(sessionId) ?? this.#deps.knownDevice?.(sessionId)
    if (known) return known
    const deviceId = await this.#deps.deviceOfSession(sessionId)
    this.#sessionDevices.set(sessionId, deviceId)
    return deviceId
  }

  noteSessionDevice(sessionId: string, deviceId: string): void {
    this.#sessionDevices.set(sessionId, deviceId)
  }

  /** The transport for one session (the adapter calls it per request; it is cheap). */
  transportFor(sessionId: string): SessionContentTransport {
    return {
      kind: "tunnel",
      request: (request) => this.#request(sessionId, request),
      openSessionStream: (id) => this.#openStream(id),
    }
  }

  async closeAll(): Promise<void> {
    const channels = [...this.#channels.values()]
    this.#channels.clear()
    await Promise.all(channels.map((pending) => pending.then((channel) => channel.close()).catch(() => undefined)))
  }

  async #connect(deviceId: string): Promise<ClientSecureChannel> {
    const pin = await this.#deps.store.pin(deviceId)
    if (!pin) throw notPaired(deviceId)
    const identity = await this.#deps.store.identity()
    const ch = newChannelId()
    let channel: ClientSecureChannel | null = null
    const wire = this.#deps.mux.wire({ deviceId, clientId: identity.clientId, ch }, {
      receive: (item) => channel?.receive(item),
      ended: (code) => channel?.ended(code),
    })
    const opened = await ClientSecureChannel.connect(deviceId, fromB64url(pin.devicePub), {
      crypto: this.#deps.crypto,
      identity: identity.noise,
      ch,
      wire,
      bind: (value) => {
        channel = value
      },
    })
    this.#adopt(deviceId, opened)
    return opened
  }

  #adopt(deviceId: string, channel: ClientSecureChannel): void {
    channel.onChannelEvent((event) => {
      if (event["type"] === "e2ee.directory_key") void this.#deps.store.addDirectoryKey(event as unknown as DirectoryKeyGrant)
    })
    channel.onClose((error) => {
      void this.#channels.get(deviceId)?.then((current) => {
        if (current === channel) this.#channels.delete(deviceId)
      })
      // The device itself said (inside the channel) that it no longer trusts this client: drop the pin so the UI
      // offers pairing again. The same code relayed by the Server is only an error: forgetting the pin on it
      // would let the Server downgrade this device to plaintext.
      if (error.fromDevice && error.code === "e2ee_not_paired") void this.#deps.store.forget(deviceId)
    })
  }

  async #request(sessionId: string, request: ContentRequest): Promise<unknown> {
    try {
      const deviceId = await this.deviceOf(sessionId)
      const pin = await this.#deps.store.pin(deviceId)
      if (!pin) throw notPaired(deviceId)
      const query = new URLSearchParams(request.query ?? {}).toString()
      const path = query ? `${request.path}?${query}` : request.path
      const body = request.body ?? null
      if (request.method !== "GET" && body && typeof body === "object" && !(body instanceof FormData)) {
        const skipped = await this.#registerCommand(deviceId, pin, body as Record<string, unknown>)
        if (skipped !== undefined) return skipped
      }
      if (body instanceof FormData) throw new ApiError({ status: 415, kind: "http", code: "e2ee_upload_unsupported", detail: "Encrypted uploads are not available yet." })
      const channel = await this.channel(deviceId)
      const response = await channel.request(request.method as ChannelMethod, path, body)
      if (response.status >= 400) {
        const detail = (response.body as { detail?: unknown } | null)?.detail
        const code = typeof detail === "object" && detail && "code" in detail ? String((detail as { code: unknown }).code) : undefined
        const message = typeof detail === "string" ? detail : typeof detail === "object" && detail && "message" in detail ? String((detail as { message: unknown }).message) : `HTTP ${response.status}`
        throw new ApiError({ status: response.status, kind: apiErrorKind(response.status), code, detail: message, payload: response.body })
      }
      return response.body
    } catch (error) {
      const apiError = toApiError(error)
      // Same signal as the HTTPS path: lets the trust UI offer pairing or reconnect.
      if (isContentTransportRequired(apiError.code)) reportContentTransportRequired(sessionId, apiError.code!)
      throw apiError
    }
  }

  /** Registers the command; returns a result to give back without sending when the Server already has one. */
  async #registerCommand(deviceId: string, pin: DevicePin, body: Record<string, unknown>): Promise<unknown | undefined> {
    const commandId = typeof body["clientMessageId"] === "string" ? body["clientMessageId"] : typeof body["commandId"] === "string" ? body["commandId"] : null
    if (!commandId) return undefined
    const key = this.#deps.store.directoryKey(pin)
    if (!key) throw notPaired(deviceId)
    const digest = await inputDigest({ digestKey: key.digest }, utf8(JSON.stringify(body)))
    const registration = await this.#deps.registerCommand({ commandId, deviceId, inputDigest: digest })
    if (!registration.duplicate || registration.outcome === null) return undefined
    if (registration.outcome === "rejected")
      throw new ApiError({ status: 409, kind: "http", code: registration.errorCode ?? "command_rejected", detail: "The device rejected this command." })
    return { accepted: true, duplicate: true, commandId }
  }

  #openStream(sessionId: string): SessionEventStream {
    let subscription: { channel: ClientSecureChannel; id: string } | null = null
    let closed = false
    let detachClose: (() => void) | null = null
    const stream: SessionEventStream = {
      onmessage: null,
      onclose: null,
      onerror: null,
      close: () => {
        if (closed) return
        closed = true
        detachClose?.()
        if (subscription) void subscription.channel.unsubscribe(subscription.id).catch(() => undefined)
        stream.onclose?.()
      },
    }
    void (async () => {
      try {
        const deviceId = await this.deviceOf(sessionId)
        const channel = await this.channel(deviceId)
        if (closed) return
        detachClose = channel.onClose(() => stream.close())
        const id = await channel.subscribe(sessionId, null, (event) => {
          if (!closed) stream.onmessage?.({ data: JSON.stringify(event) })
        })
        subscription = { channel, id }
        if (closed) void channel.unsubscribe(id).catch(() => undefined)
      } catch (error) {
        if (closed) return
        stream.onerror?.()
        stream.close()
        void error
      }
    })()
    return stream
  }
}
