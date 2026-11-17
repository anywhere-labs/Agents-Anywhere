/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact read-blob-request. Do not edit; run `yarn contracts:generate`. */

export type Blobref = string
export type Sessionid = string
export type Path = string
export type Token = string
export type Transferid = string

/**
 * ``Store/readBlob``: a stored blob or attachment, relayed over HTTP.
 */
export interface ReadBlobRequest {
  blobRef: Blobref
  sessionId: Sessionid
  transfer: BlobTransfer
  [k: string]: unknown
}
/**
 * Where the device ``PUT``s the bytes (``DEVICE_TRANSFER_PATH``) and the one-time token.
 */
export interface BlobTransfer {
  path: Path
  token: Token
  transferId: Transferid
  [k: string]: unknown
}
