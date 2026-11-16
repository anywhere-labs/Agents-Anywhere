/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact sealed-attachment-key.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Fileid = string
/**
 * 32 bytes, base64url without padding
 */
export type Key = string
/**
 * real media type; the upload itself is application/octet-stream
 */
export type Mimetype = string | null
/**
 * real file name; the upload itself is named attachment.bin
 */
export type Name = string | null
/**
 * hex SHA-256 of the plaintext; also the segment AD objectId
 */
export type Sha256 = string
/**
 * plaintext size
 */
export type Size = number

/**
 * Travels inside the channel with the request that references an encrypted upload: the request body
 * carries ``sealedAttachmentKeys: [SealedAttachmentKey]`` next to its usual ``attachments``. The Server only
 * ever holds the ciphertext.
 *
 * The upload's segments are sealed before the Server assigns ``fileId``, so their AD uses
 * ``objectId = sha256`` (``sealed_segment_ad("attachment", sha256, i, final)``); the key is random per file,
 * so a swapped upload fails to open either way. The device checks ``size`` and ``sha256`` after opening.
 */
export interface SealedAttachmentKey {
  fileId: Fileid
  key: Key
  mimeType?: Mimetype
  name?: Name
  sha256: Sha256
  size: Size
  [k: string]: unknown
}
