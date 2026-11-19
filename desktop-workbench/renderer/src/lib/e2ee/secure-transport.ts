// Encrypted session content (docs/v3/11-e2ee-noise.md §10): implements the transport adapter's
// `SessionContentTransport` over one secure channel per device. Requests become `TunnelRequest`s, the session
// stream a `TunnelSubscribe`; commands are registered with the Server first (`POST /api/v3/e2ee/commands`).
// Device content without a session (files, terminals, session creation) uses the same channel; attachments are
// sealed and uploaded as ciphertext, their keys travel with the request that uses them.

import type { EncryptedTunnelGrant } from "@/generated/device-content/v1_0/encrypted-tunnel-grant"
import { ApiError, apiErrorKind } from "@/lib/api/errors"
import {
  isContentTransportRequired,
  reportContentTransportRequired,
  type ContentRequest,
  type SessionContentTransport,
  type SessionEventStream,
} from "@/lib/transport/content-transport"
import { b64url, buf, utf8 } from "./bytes"
import {
  ChannelClosedError,
  type ContentChannel,
  type ChannelMethod,
  type DirectoryKeyGrant,
  type PairingPayload,
  type SubscribeTarget,
} from "./content-channel"
import { inputDigest } from "./formats"
import { openMeshContent } from "./mesh-content-channel"
import { AttachmentKeyRing, SEALED_UPLOAD_NAME, SEALED_UPLOAD_TYPE, sealAttachment } from "./sealed-attachments"
import type { ClientTrustStore, DevicePin } from "./trust-store"

export interface CommandRegistrationView {
  readonly commandId: string
  readonly outcome: "accepted" | "rejected" | null
  readonly errorCode: string | null
  readonly duplicate: boolean
}

interface SecureTransportServices {
  readonly store: ClientTrustStore
  readonly label: string
  readonly platform: "web" | "desktop"
  /** `POST /api/v3/e2ee/commands`. */
  registerCommand(registration: { commandId: string; deviceId: string; inputDigest: string }): Promise<CommandRegistrationView>
  /** Plaintext session metadata: which device holds the session (`GET /api/v2/sessions/{id}/meta`). */
  deviceOfSession(sessionId: string): Promise<string>
  /** Already known from the session list (no request needed). */
  knownDevice?(sessionId: string): string | undefined
  /**
   * `POST {path}` over plain HTTPS with `x-aa-sealed: segments-v1` (the Server lets it through: every file part
   * is ciphertext). Resolves the Server's `AttachmentUploadResponse`.
   */
  uploadSealed?(path: string, form: FormData): Promise<unknown>
  /** How long a session creation through the channel may take before its result counts as unknown (75 s). */
  readonly createTimeoutMs?: number
}

interface ContentChannelProvider {
  pair(payload: PairingPayload): Promise<{ channel: ContentChannel; grantedAt: string; directoryKey: DirectoryKeyGrant }>
  connect(deviceId: string, pin: DevicePin): Promise<ContentChannel>
}

export type SecureTransportDeps = SecureTransportServices & (
  | { readonly bootstrap: () => Promise<EncryptedTunnelGrant>; readonly provider?: never }
  | { readonly bootstrap?: never; readonly provider: ContentChannelProvider }
)

type ContentTarget = { readonly sessionId: string } | { readonly deviceId: string }

const ATTACHMENT_UPLOAD_PATH = /^(?:\/api\/v\d+)?\/sessions\/[^/?#]+\/attachments$/
const SESSION_CREATE_PATH = /^(?:\/api\/v\d+)?\/sessions(?:\/create-and-start)?$/
export const SESSION_CREATE_TIMEOUT_MS = 75_000

const notPaired = (deviceId: string) =>
  new ApiError({ status: 409, kind: "http", code: "e2ee_not_paired", detail: `Pair this client with device ${deviceId} first.` })

/** The device may or may not have created the session: never resend blindly; look for it first. */
const creationOutcomeUnknown = () =>
  new ApiError({
    status: 504,
    kind: apiErrorKind(504),
    code: "command_outcome_unknown",
    detail: "The device did not confirm the new session in time.",
    payload: { detail: { resultUnknown: true, retryable: false } },
  })

/** Nothing was sent: the session was certainly not created. */
const NOT_CREATED = { platformSessionCreated: false, created: false, messageAccepted: false, resultUnknown: false }

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof ChannelClosedError) {
    const status = error.code === "connector_offline" ? 503 : 409
    return new ApiError({ status, kind: apiErrorKind(status), code: error.code, detail: error.message })
  }
  return new ApiError({ status: 0, kind: "network", detail: (error as Error)?.message ?? "secure channel failed" })
}

/** The device's answer, or an unknown outcome after `ms` (the request may still have been carried out). */
function withTimeout<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(creationOutcomeUnknown()), ms)
  })
  return Promise.race([pending, expired]).finally(() => clearTimeout(timer))
}

/** One secure channel per paired device, opened on demand and shared by every session of that device. */
export class SecureChannelPool {
  readonly #deps: SecureTransportDeps
  readonly #channels = new Map<string, Promise<ContentChannel>>()
  readonly #pairing = new Map<string, Promise<DevicePin>>()
  readonly #sessionDevices = new Map<string, string>()
  readonly #attachmentKeys = new AttachmentKeyRing()

  constructor(deps: SecureTransportDeps) {
    this.#deps = deps
  }

  /** First pairing from a QR code / `aa-pair://` link. Keeps the new channel open for use. */
  async pair(payload: PairingPayload, deviceLabel?: string): Promise<DevicePin> {
    if (this.#deps.bootstrap) {
      if (this.#pairing.has(payload.deviceId)) throw new ChannelClosedError("pairing_in_progress")
      const pending = this.#pairMesh(payload, this.#deps.bootstrap, deviceLabel)
      this.#pairing.set(payload.deviceId, pending)
      try {
        return await pending
      } finally {
        this.#pairing.delete(payload.deviceId)
      }
    }
    const result = await this.#deps.provider.pair(payload)
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

  async #pairMesh(
    payload: PairingPayload, bootstrap: () => Promise<EncryptedTunnelGrant>, label?: string,
  ): Promise<DevicePin> {
    const old = await this.#deps.store.pin(payload.deviceId)
    if (old && old.devicePub !== payload.deviceIdentityPub) throw new ChannelClosedError("device_pin_mismatch")
    const identity = await this.#deps.store.identity()
    const secret = await this.#deps.store.meshCredential(payload.deviceId, payload.deviceIdentityPub, true)
    if (!secret) throw notPaired(payload.deviceId)
    const channel = await openMeshContent(bootstrap, payload.deviceId, payload.deviceIdentityPub)
    try {
      const paired = await channel.pair({
        pairingId: payload.pairingId,
        pairingSecret: payload.psk,
        clientIdentityPub: b64url(identity.publicKey),
        clientSecret: secret,
        label: this.#deps.label,
        platform: this.#deps.platform,
      })
      if (paired.clientId !== identity.clientId || paired.directoryKey.deviceId !== payload.deviceId) {
        throw new ChannelClosedError("device_pin_mismatch")
      }
      const pin = await this.#deps.store.savePairing({
        deviceId: payload.deviceId,
        devicePub: payload.deviceIdentityPub,
        label: label || payload.deviceId,
        grantedAt: paired.grantedAt,
        directoryKey: paired.directoryKey,
      })
      const previous = this.#channels.get(payload.deviceId)
      this.#channels.set(payload.deviceId, Promise.resolve(channel))
      channel.authorize(identity.clientId, secret)
      this.#adopt(payload.deviceId, channel)
      channel.watchTrust()
      void previous?.then((oldChannel) => oldChannel.close()).catch(() => undefined)
      return pin
    } catch (error) {
      await channel.close()
      throw error
    }
  }

  /** The open channel to `deviceId`, opening a new scoped tunnel when needed. */
  channel(deviceId: string): Promise<ContentChannel> {
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
      request: (request) => this.#request({ sessionId }, request),
      openSessionStream: (id) => this.#openStream({ sessionId: id }, { stream: "session", sessionId: id }),
      openTerminalStream: (terminalId) => this.#openStream({ sessionId }, { stream: "terminal", terminalId }),
    }
  }

  /** The transport for device content without a session: files, terminals, session creation. */
  transportForDevice(deviceId: string): SessionContentTransport {
    return {
      kind: "tunnel",
      request: (request) => this.#request({ deviceId }, request),
      openSessionStream: (id) => this.#openStream({ sessionId: id }, { stream: "session", sessionId: id }),
      openTerminalStream: (terminalId) => this.#openStream({ deviceId }, { stream: "terminal", terminalId }),
    }
  }

  async closeAll(): Promise<void> {
    const channels = [...this.#channels.values()]
    this.#channels.clear()
    this.#attachmentKeys.clear()
    await Promise.all(channels.map((pending) => pending.then((channel) => channel.close()).catch(() => undefined)))
  }

  async #connect(deviceId: string): Promise<ContentChannel> {
    const pin = await this.#deps.store.pin(deviceId)
    if (!pin) throw notPaired(deviceId)
    const identity = await this.#deps.store.identity()
    if (this.#deps.bootstrap) {
      const secret = await this.#deps.store.meshCredential(deviceId, pin.devicePub)
      if (!secret) throw notPaired(deviceId)
      const channel = await openMeshContent(this.#deps.bootstrap, deviceId, pin.devicePub)
      channel.authorize(identity.clientId, secret)
      this.#adopt(deviceId, channel)
      channel.watchTrust()
      return channel
    }
    const opened = await this.#deps.provider.connect(deviceId, pin)
    this.#adopt(deviceId, opened)
    return opened
  }

  #adopt(deviceId: string, channel: ContentChannel): void {
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

  async #request(target: ContentTarget, request: ContentRequest): Promise<unknown> {
    const sessionId = "sessionId" in target ? target.sessionId : null
    try {
      const deviceId = "deviceId" in target ? target.deviceId : await this.deviceOf(target.sessionId)
      const pin = await this.#deps.store.pin(deviceId)
      if (!pin) throw notPaired(deviceId)
      const query = new URLSearchParams(request.query ?? {}).toString()
      const path = query ? `${request.path}?${query}` : request.path
      let body = request.body ?? null
      if (body instanceof FormData) {
        // Files never enter the channel as plaintext uploads: they are sealed and uploaded as ciphertext.
        if (request.method === "POST" && ATTACHMENT_UPLOAD_PATH.test(request.path)) return await this.#uploadSealed(path, body)
        throw new ApiError({ status: 415, kind: "http", code: "e2ee_upload_unsupported", detail: "Encrypted uploads are not available for this request." })
      }
      // Session creation: the device chosen by `connectorId` creates and runs the session (its first message is
      // content). The first message has no upload yet, so attachments are refused before anything is sent.
      const creating = request.method === "POST" && SESSION_CREATE_PATH.test(request.path)
      const attachments = (body as { attachments?: unknown } | null)?.attachments
      if (creating && Array.isArray(attachments) && attachments.length > 0)
        throw new ApiError({
          status: 409,
          kind: "http",
          code: "e2ee_attachments_unsupported",
          detail: "The first message of an end-to-end encrypted session cannot carry attachments yet.",
          payload: { detail: NOT_CREATED },
        })
      if (request.method !== "GET" && body && typeof body === "object" && !Array.isArray(body)) {
        // The keys of sealed uploads travel with the request that uses them, inside the channel.
        body = this.#attachmentKeys.attach(body as Record<string, unknown>)
        const skipped = await this.#registerCommand(deviceId, pin, body as Record<string, unknown>, creating)
        if (skipped !== undefined) return skipped
      }
      const channel = await this.channel(deviceId)
      const pending = channel.request(request.method as ChannelMethod, path, body)
      const response = creating ? await withTimeout(pending, this.#deps.createTimeoutMs ?? SESSION_CREATE_TIMEOUT_MS) : await pending
      if (response.status >= 400) {
        const detail = (response.body as { detail?: unknown } | null)?.detail
        const code = typeof detail === "object" && detail && "code" in detail ? String((detail as { code: unknown }).code) : undefined
        const message = typeof detail === "string" ? detail : typeof detail === "object" && detail && "message" in detail ? String((detail as { message: unknown }).message) : `HTTP ${response.status}`
        throw new ApiError({ status: response.status, kind: apiErrorKind(response.status), code, detail: message, payload: response.body })
      }
      if (creating) {
        const created = (response.body as { session?: { id?: unknown } } | null)?.session?.id
        if (typeof created === "string") this.noteSessionDevice(created, deviceId)
      }
      return response.body
    } catch (error) {
      const apiError = toApiError(error)
      // Same signal as the HTTPS path: lets the trust UI offer pairing or reconnect.
      if (isContentTransportRequired(apiError.code)) reportContentTransportRequired(sessionId, apiError.code!)
      throw apiError
    }
  }

  /**
   * Seals every file of an attachment upload with its own key and uploads the ciphertext over HTTPS: one
   * multipart request per file (the contract allows one file part), named `attachment.bin`.
   */
  async #uploadSealed(path: string, form: FormData): Promise<unknown> {
    const upload = this.#deps.uploadSealed
    if (!upload) throw new ApiError({ status: 415, kind: "http", code: "e2ee_upload_unsupported", detail: "Encrypted uploads are not available yet." })
    const entries = [...form.entries()]
    const fields = entries.filter((entry): entry is [string, string] => typeof entry[1] === "string")
    const views: Array<Record<string, unknown>> = []
    let last: Record<string, unknown> | null = null
    for (const [field, value] of entries) {
      if (typeof value === "string") continue
      const file = await sealAttachment(new Uint8Array(await value.arrayBuffer()))
      const name = value.name || "attachment"
      const mimeType = value.type
      const sealedForm = new FormData()
      for (const [key, text] of fields) sealedForm.append(key, text)
      // The Server sees neither the name nor the type: both go to the device with the key.
      sealedForm.append(field, new Blob([buf(file.body)], { type: SEALED_UPLOAD_TYPE }), SEALED_UPLOAD_NAME)
      last = (await upload(path, sealedForm)) as Record<string, unknown> | null
      const view = (last?.["attachments"] as Array<Record<string, unknown>> | undefined)?.[0]
      if (!view || typeof view["fileId"] !== "string")
        throw new ApiError({ status: 502, kind: "http", code: "e2ee_upload_failed", detail: "The Server did not confirm the sealed upload." })
      this.#attachmentKeys.remember(view["fileId"], file, { name, mimeType: mimeType || null })
      // The Server's name, type, size and digest describe the ciphertext; the UI shows the file.
      views.push({ ...view, name, size: file.size, ...(mimeType ? { mediaType: mimeType } : {}) })
    }
    return { ...last, attachments: views }
  }

  /** Registers the command; returns a result to give back without sending when the Server already has one. */
  async #registerCommand(deviceId: string, pin: DevicePin, body: Record<string, unknown>, creating = false): Promise<unknown | undefined> {
    const commandId = typeof body["clientMessageId"] === "string" ? body["clientMessageId"] : typeof body["commandId"] === "string" ? body["commandId"] : null
    if (!commandId) return undefined
    const key = this.#deps.store.directoryKey(pin)
    if (!key) throw notPaired(deviceId)
    const digest = await inputDigest({ digestKey: key.digest }, utf8(JSON.stringify(body)))
    const registration = await this.#deps.registerCommand({ commandId, deviceId, inputDigest: digest })
    if (!registration.duplicate) return undefined
    if (registration.outcome === "rejected")
      throw new ApiError({ status: 409, kind: "http", code: registration.errorCode ?? "command_rejected", detail: "The device rejected this command.", ...(creating ? { payload: { detail: NOT_CREATED } } : {}) })
    // A repeated creation must not create a second session: its result is unknown until the session list says.
    if (creating) throw creationOutcomeUnknown()
    if (registration.outcome === null) return undefined
    return { accepted: true, duplicate: true, commandId }
  }

  #openStream(target: ContentTarget, spec: SubscribeTarget): SessionEventStream {
    let subscription: { channel: ContentChannel; id: string } | null = null
    let closed = false
    let detachClose: (() => void) | null = null
    const stream: SessionEventStream = {
      onopen: null,
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
        const deviceId = "deviceId" in target ? target.deviceId : await this.deviceOf(target.sessionId)
        const channel = await this.channel(deviceId)
        if (closed) return
        detachClose = channel.onClose((error) => {
          if (isContentTransportRequired(error.code)) {
            reportContentTransportRequired("sessionId" in target ? target.sessionId : null, error.code)
          }
          stream.close()
        })
        const id = await channel.subscribe(spec, (event) => {
          if (!closed) stream.onmessage?.({ data: JSON.stringify(event) })
        })
        subscription = { channel, id }
        if (closed) void channel.unsubscribe(id).catch(() => undefined)
        else stream.onopen?.()
      } catch (error) {
        if (closed) return
        stream.onerror?.()
        stream.close()
        const apiError = toApiError(error)
        if (isContentTransportRequired(apiError.code)) {
          reportContentTransportRequired("sessionId" in target ? target.sessionId : null, apiError.code!)
        }
      }
    })()
    return stream
  }
}
