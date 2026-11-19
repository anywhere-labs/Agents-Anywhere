import { fromB64url, fromUtf8 } from "./bytes"

export interface PairingPayload {
  readonly v: 1
  readonly deviceId: string
  readonly deviceIdentityPub: string
  readonly pairingId: string
  readonly psk: string
  readonly serverUrl: string
  readonly e2eeMode: "off" | "required"
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

export type ChannelMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/** What a `TunnelSubscribe` opens: the session WebSocket, or device terminal `terminals-v2/{terminalId}/stream`. */
export type SubscribeTarget =
  | { readonly stream: "session"; readonly sessionId: string; readonly afterCursor?: string | null }
  | { readonly stream: "terminal"; readonly terminalId: string }

/** The channel failed or was closed; `code` is an AA error code (`e2ee_not_paired`, `pairing_expired`, …). */
export class ChannelClosedError extends Error {
  override readonly name = "ChannelClosedError"
  constructor(
    readonly code: string,
    message = code,
    /** True only for an authenticated close from the device. */
    readonly fromDevice = false,
  ) {
    super(message)
  }
}

export function parsePairingUri(uri: string): PairingPayload {
  const prefix = "aa-pair://"
  const trimmed = uri.trim()
  if (!trimmed.startsWith(prefix)) throw new RangeError("not an aa-pair:// URI")
  let payload: PairingPayload
  try {
    payload = JSON.parse(fromUtf8(fromB64url(trimmed.slice(prefix.length)))) as PairingPayload
  } catch {
    throw new RangeError("malformed pairing payload")
  }
  if (
    payload?.v !== 1 ||
    typeof payload.deviceId !== "string" ||
    typeof payload.pairingId !== "string" ||
    fromB64url(String(payload.deviceIdentityPub)).length !== 32 ||
    fromB64url(String(payload.psk)).length !== 32
  )
    throw new RangeError("malformed pairing payload")
  return payload
}

export interface ContentChannel {
  onChannelEvent(listener: (event: Record<string, unknown>) => void): () => void
  onClose(listener: (error: ChannelClosedError) => void): () => void
  request(method: ChannelMethod, path: string, body?: unknown): Promise<{ status: number; body: unknown }>
  subscribe(target: SubscribeTarget, onEvent: (event: Record<string, unknown>) => void): Promise<string>
  unsubscribe(id: string): Promise<void>
  close(): Promise<void>
}
