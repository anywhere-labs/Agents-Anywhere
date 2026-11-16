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
 * hex SHA-256 of the plaintext
 */
export type Sha256 = string
/**
 * plaintext size
 */
export type Size = number

/**
 * Travels inside the channel with the request that references an encrypted upload
 * (``AttachmentRef.encrypted = true``); the Server only ever holds the ciphertext.
 */
export interface SealedAttachmentKey {
  fileId: Fileid
  key: Key
  sha256: Sha256
  size: Size
  [k: string]: unknown
}
