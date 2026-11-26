// Attachment and image bytes over the bridge (docs/v3/mobile-bridge.md §3 `file.read` → §2 `file.data`): the WebView
// never fetches; it asks native, which reads the file through the device tunnel. Results are kept as object URLs by
// path (bounded, oldest let go first) so the thread can draw `<img src>` synchronously once they are in.

import type { FileDataMessage, OutboundMessage } from "./protocol"

export interface FileResult {
  bytes: Uint8Array
  mime: string
}

type Entry =
  | { state: "loading"; promise: Promise<FileResult> }
  | { state: "ready"; url: string; mime: string; size: number }
  | { state: "error"; error: string }

interface Pending {
  resolve(result: FileResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface FileCacheOptions {
  post(message: OutboundMessage): void
  /** Most entries kept (object URLs revoked beyond it). */
  maxEntries?: number
  /** A request native never answers fails after this. */
  timeoutMs?: number
  /** `max_bytes` sent with image reads (doc §3.3: ≤ 8 MiB goes through the tunnel). */
  maxBytes?: number
}

/** 1×1 transparent GIF: what an image shows while its bytes are on the way. */
export const PLACEHOLDER_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

export function base64ToUint8(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function objectUrl(bytes: Uint8Array, mime: string): string {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof Blob !== "undefined") {
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  }
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return `data:${mime};base64,${btoa(bin)}`
}

function revoke(url: string) {
  if (url.startsWith("blob:") && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url)
}

export class FileCache {
  private readonly opts: Required<FileCacheOptions>
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<() => void>()
  private counter = 0
  /** Bumped whenever an entry settles: the thread re-reads its image sources. */
  version = 0

  constructor(opts: FileCacheOptions) {
    this.opts = { maxEntries: 64, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024, ...opts }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  getVersion = () => this.version

  /** Ask native for a file's bytes. Concurrent reads of one path share the request. */
  read(path: string, maxBytes?: number): Promise<FileResult> {
    const request_id = `file_${++this.counter}_${Math.random().toString(36).slice(2, 8)}`
    return new Promise<FileResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id)
        reject(new Error("file.read timed out"))
      }, this.opts.timeoutMs)
      this.pending.set(request_id, { resolve, reject, timer })
      this.opts.post({ type: "file.read", request_id, path, ...(maxBytes ? { max_bytes: maxBytes } : {}) })
    })
  }

  /** An object URL for the file once it is here; asks for it (once) and returns undefined until then. */
  url(path: string, mime?: string): string | undefined {
    const entry = this.entries.get(path)
    if (entry?.state === "ready") {
      // Most recently used last.
      this.entries.delete(path)
      this.entries.set(path, entry)
      return entry.url
    }
    if (entry) return undefined
    const promise = this.read(path, this.opts.maxBytes)
    this.entries.set(path, { state: "loading", promise })
    promise.then(
      (result) => {
        if (this.entries.get(path)?.state !== "loading") return
        const type = mime || result.mime || "application/octet-stream"
        this.entries.set(path, { state: "ready", url: objectUrl(result.bytes, type), mime: type, size: result.bytes.length })
        this.evict()
        this.changed()
      },
      (error: Error) => {
        if (this.entries.get(path)?.state !== "loading") return
        this.entries.set(path, { state: "error", error: error.message })
        this.changed()
      }
    )
    return undefined
  }

  status(path: string): Entry["state"] | "none" {
    return this.entries.get(path)?.state ?? "none"
  }

  /** `file.data` from native. Unknown ids (timed out, or another page's) are ignored. */
  handle(message: FileDataMessage) {
    const p = this.pending.get(message.request_id)
    if (!p) return
    this.pending.delete(message.request_id)
    clearTimeout(p.timer)
    if (!message.ok || typeof message.base64 !== "string") {
      p.reject(new Error(message.error || "file.read failed"))
      return
    }
    try {
      p.resolve({ bytes: base64ToUint8(message.base64), mime: message.mime ?? "" })
    } catch {
      p.reject(new Error("file.data: invalid base64"))
    }
  }

  /** A new conversation: forget everything (object URLs revoked, waiting reads failed). */
  clear() {
    for (const e of this.entries.values()) if (e.state === "ready") revoke(e.url)
    this.entries.clear()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error("cleared"))
    }
    this.pending.clear()
    this.changed()
  }

  private evict() {
    let ready = 0
    for (const e of this.entries.values()) if (e.state === "ready") ready++
    for (const [path, e] of this.entries) {
      if (ready <= this.opts.maxEntries) break
      if (e.state !== "ready") continue
      revoke(e.url)
      this.entries.delete(path)
      ready--
    }
  }

  private changed() {
    this.version++
    for (const l of [...this.listeners]) l()
  }
}
