/**
 * Transport adapter for session content (v3, E2EE-ready skeleton).
 *
 * In normal mode every session read, command and the session event stream go
 * over plain HTTPS and the session WebSocket. With end-to-end encryption
 * (`contracts/e2ee/1.0`) the same client API runs inside a Noise channel to
 * the device: requests become `TunnelRequest`s and the session stream becomes
 * a tunnel subscription. The encrypted transport is installed by the trust
 * layer; everything else in the client only talks to this module, so neither
 * mode leaks into feature code.
 */

export type ContentMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/** One client API call, exactly as it would be sent in normal mode. */
export type ContentRequest = {
  method: ContentMethod
  /** Namespaced client API path, e.g. `/api/v2/sessions/{id}/snapshot`. */
  path: string
  query?: Record<string, string>
  body?: unknown
}

/** The shape the session controller needs from a realtime stream; a WebSocket satisfies it. */
export type SessionEventStream = {
  onmessage: ((message: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  close(): void
}

/** Normal mode: the ticketed session WebSocket behind the same interface. */
export function socketEventStream(socket: WebSocket): SessionEventStream {
  const stream: SessionEventStream = { onmessage: null, onclose: null, onerror: null, close: () => socket.close() }
  socket.onmessage = (event) => stream.onmessage?.({ data: event.data })
  socket.onclose = () => stream.onclose?.()
  socket.onerror = () => stream.onerror?.()
  return stream
}

export type SessionContentTransport = {
  readonly kind: "tunnel"
  /** Resolves the response body or rejects with an `ApiError` (status and stable code). */
  request(request: ContentRequest): Promise<unknown>
  /** Opens the session's realtime stream; events use the normal-mode envelope. */
  openSessionStream(sessionId: string): SessionEventStream
}

/**
 * Picks the transport for one session's content. `null` keeps normal mode.
 * The trust layer decides by device (each device has its own channel) and by
 * path (metadata such as the session list stays on the Server API).
 */
export type ContentTransportResolver = (target: { sessionId: string; method: ContentMethod; path: string }) =>
  SessionContentTransport | null

let resolver: ContentTransportResolver = () => null
const requiredListeners = new Set<(detail: { sessionId: string | null; code: string }) => void>()

/** Installs the encrypted transport; returns a function that restores normal mode. */
export function setContentTransportResolver(next: ContentTransportResolver): () => void {
  resolver = next
  return () => {
    if (resolver === next) resolver = () => null
  }
}

export function contentTransportFor(sessionId: string, method: ContentMethod = "GET", path = ""): SessionContentTransport | null {
  return resolver({ sessionId, method, path })
}

/**
 * Codes that mean the content can only be reached through an encrypted
 * channel this client does not have yet (`06-protocols.md` §6).
 */
const TRANSPORT_REQUIRED_CODES: ReadonlySet<string> = new Set(["e2ee_required", "e2ee_not_paired", "device_pin_mismatch"])

export function isContentTransportRequired(code: string | null | undefined): boolean {
  return Boolean(code && TRANSPORT_REQUIRED_CODES.has(code))
}

/** The trust layer listens to start pairing or reconnect its channel. */
export function onContentTransportRequired(listener: (detail: { sessionId: string | null; code: string }) => void): () => void {
  requiredListeners.add(listener)
  return () => {
    requiredListeners.delete(listener)
  }
}

export function reportContentTransportRequired(sessionId: string | null, code: string) {
  for (const listener of requiredListeners) {
    try {
      listener({ sessionId, code })
    } catch {
      // A failing listener must not hide the original API error.
    }
  }
}

const SESSION_CONTENT_PATH = /^(?:\/api\/v\d+)?\/sessions\/([^/?#]+)(?:\/[^?#]*)?$/
// Account-level collections under /sessions; every other segment is a session ID.
const NOT_SESSION_IDS: ReadonlySet<string> = new Set([
  "list", "read", "archive", "unarchive", "archive-all", "create", "create-and-start", "inventory",
])

/** The session a client API path belongs to, or `null` for account-level paths. */
export function sessionIdOfContentPath(path: string): string | null {
  const match = SESSION_CONTENT_PATH.exec(path.split("?")[0] ?? "")
  if (!match) return null
  const id = decodeURIComponent(match[1]!)
  return NOT_SESSION_IDS.has(id) ? null : id
}
