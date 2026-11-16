/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact tunnel-file-chunk. Do not edit; run `yarn contracts:generate`. */

/**
 * base64 (standard alphabet) of the bytes at [offset, offset + len)
 */
export type Data = string
export type Encoding = "base64"
export type Eof = boolean
export type Offset = number
/**
 * total file size
 */
export type Size = number

/**
 * Response body of a file read through the channel:
 * ``GET /api/v2/connectors/{deviceId}/fs/read?path=…&offset=…&length=…`` (``length`` at most
 * ``FILE_CHUNK_MAX_BYTES``; the device may return less). Large files are read chunk by chunk; each chunk is a
 * normal channel message, so it is encrypted and fragmented like any other.
 */
export interface TunnelFileChunk {
  data: Data
  encoding?: Encoding
  eof: Eof
  offset: Offset
  size: Size
  [k: string]: unknown
}
