/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact export-share-chunk. Do not edit; run `yarn contracts:generate`. */

export type Chunk = ShareExportPart | string
export type Attachments = string[]
export type Items = {
  [k: string]: unknown
}[]
export type End = boolean
export type Seq = number

export interface ExportShareChunk {
  chunk: Chunk
  end?: End
  seq: Seq
  [k: string]: unknown
}
/**
 * Chunks are merged in order: ``items`` concatenated, ``attachments`` (file ids) united.
 */
export interface ShareExportPart {
  attachments?: Attachments
  items?: Items
  [k: string]: unknown
}
