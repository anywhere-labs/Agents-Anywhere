// Fields a v3 device moved out of a timeline item into its local blob store (protocol 1.2 `TimelineItem.blobRefs`),
// read back slice by slice through `GET /sessions/{id}/blobs/{blobRef}` (protocol 1.2 `SessionBlobChunk`). The
// same route reads an attachment the device holds, by its `fileId`.

import type { SessionBlobChunk } from "@/generated/protocol/v1_2/session-blob-chunk"

export type { SessionBlobChunk }

export type TimelineBlobRef = {
  /** JSON pointer into the item's content where the preview or placeholder is. */
  path: string
  blobId: string
  bytes: number
  mediaType: string | null
}

export type TimelineBlobKind = "text" | "image" | "file"

/** Largest slice one read asks for (protocol 1.2 `SESSION_BLOB_CHUNK_MAX_BYTES`). */
export const SESSION_BLOB_CHUNK_MAX_BYTES = 4 * 1024 * 1024
/** Text above this is offered as a download rather than shown in the timeline. */
export const BLOB_INLINE_TEXT_MAX_BYTES = 4 * 1024 * 1024
/** Images above this are offered as a download rather than shown in the timeline. */
export const BLOB_INLINE_IMAGE_MAX_BYTES = 20 * 1024 * 1024
/** Largest blob a client reads into memory at all. */
export const BLOB_READ_MAX_BYTES = 64 * 1024 * 1024

/** The well-formed `blobRefs` of an item (anything else in the field is ignored). */
export function timelineBlobRefs(item: { blobRefs?: unknown }): TimelineBlobRef[] {
  if (!Array.isArray(item.blobRefs)) return []
  return item.blobRefs.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return []
    const ref = raw as Record<string, unknown>
    if (typeof ref.blobId !== "string" || !ref.blobId || typeof ref.path !== "string") return []
    const bytes = typeof ref.bytes === "number" && Number.isFinite(ref.bytes) && ref.bytes >= 0 ? ref.bytes : 0
    const mediaType = typeof ref.mediaType === "string" && ref.mediaType ? ref.mediaType : null
    return [{ path: ref.path, blobId: ref.blobId, bytes, mediaType }]
  })
}

/** How the timeline offers a blob: text and images within their limits inline, anything else as a file. */
export function blobKind(ref: Pick<TimelineBlobRef, "bytes" | "mediaType">): TimelineBlobKind {
  const mediaType = (ref.mediaType ?? "").toLowerCase()
  if (mediaType.startsWith("text/") && ref.bytes <= BLOB_INLINE_TEXT_MAX_BYTES) return "text"
  if (mediaType.startsWith("image/") && ref.bytes <= BLOB_INLINE_IMAGE_MAX_BYTES) return "image"
  return "file"
}

export class SessionBlobError extends Error {
  readonly code: "blob_too_large" | "blob_invalid"

  constructor(code: "blob_too_large" | "blob_invalid", message: string) {
    super(message)
    this.code = code
    this.name = "SessionBlobError"
  }
}

export type SessionBlobChunkReader = (blobRef: string, offset: number, length: number) => Promise<SessionBlobChunk>

export type SessionBlobContent = {
  bytes: Uint8Array<ArrayBuffer>
  name: string
  mediaType: string
  size: number
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Reads a whole blob slice by slice until `eof`, checking that the slices line up with the size the device gave. */
export async function readSessionBlob(
  read: SessionBlobChunkReader,
  blobRef: string,
  options: { maxBytes?: number; chunkBytes?: number; signal?: AbortSignal } = {},
): Promise<SessionBlobContent> {
  const maxBytes = options.maxBytes ?? BLOB_READ_MAX_BYTES
  const length = Math.max(1, Math.min(options.chunkBytes ?? SESSION_BLOB_CHUNK_MAX_BYTES, SESSION_BLOB_CHUNK_MAX_BYTES))
  const parts: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (;;) {
    options.signal?.throwIfAborted()
    const chunk = await read(blobRef, offset, length)
    if (!chunk || (chunk.encoding ?? "base64") !== "base64" || typeof chunk.data !== "string" || chunk.offset !== offset)
      throw new SessionBlobError("blob_invalid", "The device sent an unexpected slice.")
    if (chunk.size > maxBytes) throw new SessionBlobError("blob_too_large", `The content is larger than ${maxBytes} bytes.`)
    const bytes = fromBase64(chunk.data)
    parts.push(bytes)
    offset += bytes.length
    if (chunk.eof) {
      if (offset !== chunk.size) throw new SessionBlobError("blob_invalid", "The device sent content of the wrong size.")
      const joined = new Uint8Array(offset)
      let at = 0
      for (const part of parts) {
        joined.set(part, at)
        at += part.length
      }
      return { bytes: joined, name: chunk.name || blobRef, mediaType: chunk.mediaType || "application/octet-stream", size: offset }
    }
    if (bytes.length === 0 || offset > chunk.size) throw new SessionBlobError("blob_invalid", "The device stopped sending the content.")
  }
}

/** The text of a `text/*` blob (UTF-8; invalid sequences become U+FFFD). */
export function blobText(content: Pick<SessionBlobContent, "bytes">): string {
  return new TextDecoder("utf-8").decode(content.bytes)
}

/** A short size for labels: `512 B`, `12.3 KB`, `4.0 MB`. */
export function formatBlobBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}
