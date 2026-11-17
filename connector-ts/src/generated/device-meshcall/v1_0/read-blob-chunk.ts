/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact read-blob-chunk. Do not edit; run `yarn contracts:generate`. */

export type Chunk = BlobHead | BlobProgress
export type Mediatype = string
export type Name = string
export type Sha256 = string
export type Size = number
export type Done = boolean
export type Progress = number | null
export type End = boolean
export type Seq = number

export interface ReadBlobChunk {
  chunk: Chunk
  end?: End
  seq: Seq
  [k: string]: unknown
}
/**
 * First ``readBlob`` item: the Server starts answering its client with these.
 */
export interface BlobHead {
  mediaType: Mediatype
  name: Name
  sha256: Sha256
  size: Size
  [k: string]: unknown
}
/**
 * Later ``readBlob`` items: progress, then ``done``.
 */
export interface BlobProgress {
  done?: Done
  progress?: Progress
  [k: string]: unknown
}
