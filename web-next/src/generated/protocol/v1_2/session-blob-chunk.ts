/* eslint-disable */
/**
 * Generated from protocol 1.2 artifact session-blob-chunk.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Blobref = string
/**
 * base64 (standard alphabet) of the bytes at [offset, offset + len)
 */
export type Data = string
export type Encoding = "base64"
export type Eof = boolean
export type Mediatype = string
export type Name = string
export type Offset = number
/**
 * total size of the blob
 */
export type Size = number

/**
 * ``GET /sessions/{id}/blobs/{blobRef}?offset=…&length=…``: a slice of a blob the device keeps for the session.
 *
 * ``blobRef`` is a ``blobRefs[].blobId`` of one of the session's items, or the ``fileId`` of an attachment of the
 * session the device holds; anything else is 404 ``blob_not_found``. ``length`` is at most
 * ``SESSION_BLOB_CHUNK_MAX_BYTES`` and the device may return less; clients read on from ``offset + len`` until
 * ``eof``. The device serves it, so it works the same through the Server and through a secure channel.
 */
export interface SessionBlobChunk {
  blobRef: Blobref
  data: Data
  encoding: Encoding
  eof: Eof
  mediaType: Mediatype
  name: Name
  offset: Offset
  size: Size
  [k: string]: unknown
}
