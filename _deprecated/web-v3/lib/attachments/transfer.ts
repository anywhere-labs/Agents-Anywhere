// Sending files to a work device (docs/v3/client-experience-proposal.md §3.2), framework-free:
//
//   ≤ the device's RPC cap (settings.max_rpc_file_bytes, 8 MiB by default)  → aa.v3.Device/save_attachment, bytes in
//                                                                              the RPC (base64), with session_id so the
//                                                                              device files it under the conversation.
//   > the cap                                                               → Cloud Drive: POST /drive/uploads
//                                                                              (presigned PUT straight to storage),
//                                                                              /drive/files/{id}/complete, then
//                                                                              aa.v3.Device/fetch_drive_file and the
//                                                                              device downloads it itself.
//   encrypted device, > the cap                                             → same, but the bytes are AES-256-GCM
//                                                                              encrypted with a one-time key that only
//                                                                              travels inside the E2EE tunnel.
//
// Limits are checked when the file is picked (planTransfer), not after a failed upload.

import type { DriveQuotaView, DriveFileView, PresignedHttpTarget } from "@/lib/types/v3"

export const DEFAULT_RPC_MAX_BYTES = 8 * 1024 * 1024
export const MAX_ATTACHMENTS = 10

export interface AttachmentRef {
  path: string
  name: string
  mime: string
  size: number
}

export type TransferRoute =
  | { kind: "rpc" }
  | { kind: "drive" }
  | { kind: "reject"; reason: "drive_disabled" | "too_large" | "quota" | "empty"; limit?: number }

export interface TransferLimits {
  /** The device's per-RPC cap (Device/get_settings). */
  rpcMaxBytes?: number | null
  /** The account's drive quota (GET /drive/quota); null when unknown or unreachable. */
  quota?: DriveQuotaView | null
}

/** The RPC cap that applies: the device's own setting, else the control plane's hint, else 8 MiB. */
export function rpcCap(limits: TransferLimits): number {
  return limits.rpcMaxBytes ?? limits.quota?.rpc_direct_max_bytes ?? DEFAULT_RPC_MAX_BYTES
}

/** Which way a file of `size` bytes goes, or why it cannot (decided when the file is picked). */
export function planTransfer(size: number, limits: TransferLimits): TransferRoute {
  if (size <= 0) return { kind: "reject", reason: "empty" }
  const cap = rpcCap(limits)
  if (size <= cap) return { kind: "rpc" }
  const q = limits.quota
  if (!q || !q.enabled) return { kind: "reject", reason: "drive_disabled", limit: cap }
  if (q.max_file_bytes != null && size > q.max_file_bytes) {
    return { kind: "reject", reason: "too_large", limit: q.max_file_bytes }
  }
  if (q.remaining_bytes != null && size > q.remaining_bytes) {
    return { kind: "reject", reason: "quota", limit: q.remaining_bytes }
  }
  return { kind: "drive" }
}

/** What the transfer needs from the device tunnel and the control plane. */
export interface TransferPorts {
  saveAttachment: (payload: {
    session_id: string
    name: string
    base64: string
    mime?: string
  }) => Promise<{ path: string; name: string; mime: string; size: number }>
  fetchDriveFile: (payload: {
    session_id: string
    file_id: string
    name: string
    mime?: string
    sha256?: string
    file_key?: string
  }) => Promise<{ path: string; name: string; mime: string; size: number }>
  createUpload: (payload: {
    purpose: "transfer"
    size_bytes: number
    sha256: string
    /** Left out for sealed (ephemeral_key) uploads: the control plane sees no plaintext metadata. */
    filename?: string | null
    mime_type?: string | null
    encryption_mode: "none" | "ephemeral_key"
    encryption_nonce?: string | null
  }) => Promise<{ file: DriveFileView; upload: PresignedHttpTarget }>
  completeUpload: (fileId: string, etag: string | null) => Promise<DriveFileView>
  /** Removes a drive object the device never took (best effort; otherwise it waits for its TTL). */
  deleteUpload?: (fileId: string) => Promise<unknown>
}

export type TransferPhase = "reading" | "uploading" | "saving"

export interface TransferProgress {
  phase: TransferPhase
  /** Bytes of the file handled so far in this phase. */
  sent: number
  total: number
}

export class TransferError extends Error {
  constructor(
    readonly code: "unimplemented" | "upload_failed" | "aborted" | "device_error",
    message: string
  ) {
    super(message)
    this.name = "TransferError"
  }
}

/** A device that does not know the method yet (older Connector): MeshCall `method_not_found` / `unimplemented`. */
export function isUnimplemented(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === "method_not_found" || code === "unimplemented"
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(out)
}

export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** A PUT to a presigned target with upload progress (fetch has none for request bodies). */
export function putWithProgress(
  target: PresignedHttpTarget,
  body: Uint8Array,
  onProgress: (sent: number) => void,
  signal?: AbortSignal
): Promise<{ etag: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(target.method, target.url)
    for (const [k, v] of Object.entries(target.headers ?? {})) {
      // The browser sets these itself and refuses them.
      if (/^(host|content-length)$/i.test(k)) continue
      xhr.setRequestHeader(k, v)
    }
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // Storage only shows ETag when its CORS rule exposes it; asking for a hidden header logs an error.
        const exposed = /^etag:/im.test(xhr.getAllResponseHeaders())
        resolve({ etag: exposed ? xhr.getResponseHeader("etag") : null })
      } else reject(new TransferError("upload_failed", `Cloud drive upload failed (HTTP ${xhr.status})`))
    }
    xhr.onerror = () => reject(new TransferError("upload_failed", "Cloud drive upload failed (network)"))
    xhr.onabort = () => reject(new TransferError("aborted", "Upload cancelled"))
    signal?.addEventListener("abort", () => xhr.abort(), { once: true })
    xhr.send(body as unknown as XMLHttpRequestBodyInit)
  })
}

/** base64url without padding (RFC 4648 §5): how the one-time key and nonce travel. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * One-time AES-256-GCM encryption for encrypted devices (§3.2, Connector `fetch_drive_file`): random 32-byte key and
 * 12-byte nonce, no AAD; the upload is ciphertext‖16-byte tag (what WebCrypto returns). The nonce goes to the drive as
 * `encryption_nonce`, the key only to the device through the E2EE tunnel; both base64url without padding.
 */
async function encryptForDevice(plain: Uint8Array): Promise<{ data: Uint8Array; key: string; nonce: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"])
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain as BufferSource))
  return { data: sealed, key: bytesToBase64Url(raw), nonce: bytesToBase64Url(nonce) }
}

/**
 * Send one file to the device and return how the message refers to it. `route` comes from planTransfer (a rejected
 * route never gets here). Throws TransferError("unimplemented") when the device cannot fetch from the drive yet.
 */
export async function transferAttachment(
  file: File,
  opts: {
    route: Exclude<TransferRoute, { kind: "reject" }>
    sessionId: string
    encrypted: boolean
    ports: TransferPorts
    onProgress?: (p: TransferProgress) => void
    signal?: AbortSignal
  }
): Promise<AttachmentRef> {
  const { route, sessionId, ports, onProgress, signal } = opts
  const mime = file.type || "application/octet-stream"
  const total = file.size
  const check = () => {
    if (signal?.aborted) throw new TransferError("aborted", "Upload cancelled")
  }

  onProgress?.({ phase: "reading", sent: 0, total })
  const bytes = new Uint8Array(await file.arrayBuffer())
  check()

  if (route.kind === "rpc") {
    onProgress?.({ phase: "saving", sent: 0, total })
    try {
      const saved = await ports.saveAttachment({
        session_id: sessionId,
        name: file.name,
        base64: bytesToBase64(bytes),
        mime,
      })
      onProgress?.({ phase: "saving", sent: total, total })
      return { path: saved.path, name: saved.name, mime: saved.mime || mime, size: saved.size }
    } catch (err) {
      throw new TransferError("device_error", err instanceof Error ? err.message : String(err))
    }
  }

  const sealed = opts.encrypted ? await encryptForDevice(bytes) : null
  const body = sealed?.data ?? bytes
  const sha256 = await sha256HexOf(body)
  check()
  const created = await ports.createUpload({
    purpose: "transfer",
    size_bytes: body.byteLength,
    sha256,
    ...(sealed ? {} : { filename: file.name, mime_type: mime }),
    encryption_mode: sealed ? "ephemeral_key" : "none",
    encryption_nonce: sealed?.nonce ?? null,
  })
  // Whatever fails from here on leaves an object the device never took: remove it rather than let it hold quota.
  const discard = () => void ports.deleteUpload?.(created.file.id)?.catch(() => undefined)
  onProgress?.({ phase: "uploading", sent: 0, total })
  try {
    const put = await putWithProgress(
      created.upload,
      body,
      (sent) => onProgress?.({ phase: "uploading", sent: Math.min(total, sent), total }),
      signal
    )
    check()
    await ports.completeUpload(created.file.id, put.etag)
  } catch (err) {
    discard()
    throw err
  }
  onProgress?.({ phase: "saving", sent: 0, total })
  try {
    const saved = await ports.fetchDriveFile({
      session_id: sessionId,
      file_id: created.file.id,
      name: file.name,
      mime,
      sha256,
      ...(sealed ? { file_key: sealed.key } : {}),
    })
    return { path: saved.path, name: saved.name, mime: saved.mime || mime, size: saved.size }
  } catch (err) {
    discard()
    if (isUnimplemented(err)) {
      throw new TransferError("unimplemented", "This device's Connector cannot receive large files yet")
    }
    throw new TransferError("device_error", err instanceof Error ? err.message : String(err))
  }
}
