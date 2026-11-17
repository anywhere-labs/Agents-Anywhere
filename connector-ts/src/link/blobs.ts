// Sources for Store/readBlob: large timeline fields (blob_<sha256>, in the store's BlobRepository) or session
// attachments (file_... already fetched to this device).
import type { BlobRepository } from '../application/ports/index.js'

/** One file `Store/readBlob` can send; the first stream item is `{name, mediaType, size, sha256}` of it. */
export interface LocalBlob {
  readonly path: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
  /** SHA-256 (hex) of the bytes that will be sent. */
  readonly sha256: string
}

/** The local copy of a session attachment (the workspace's attachment cache supplies it). */
export type FindAttachment = (sessionId: string, fileId: string) => Promise<LocalBlob | null>

export interface BlobLookupDeps {
  readonly blobs: Pick<BlobRepository, 'get' | 'path' | 'referencedBy'>
  readonly attachment: FindAttachment
}

/** `blob_…` refs come from the store; anything else is an attachment file id of the session. Null when absent. */
export function blobLookup(deps: BlobLookupDeps): (sessionId: string, blobRef: string) => Promise<LocalBlob | null> {
  return async (sessionId, blobRef) => {
    if (!blobRef.startsWith('blob_')) return deps.attachment(sessionId, blobRef)
    // Content-addressed ids are shared across sessions; only a blob this session's timeline points at is its own.
    if (!await deps.blobs.referencedBy(sessionId, blobRef)) return null
    const record = await deps.blobs.get(blobRef)
    const path = record === null ? null : await deps.blobs.path(blobRef)
    if (record === null || path === null) return null
    return { path, name: blobRef, mediaType: record.mediaType ?? 'application/octet-stream', size: record.size, sha256: record.sha256 }
  }
}
