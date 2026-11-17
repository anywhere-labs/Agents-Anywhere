/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact stream-chunk. Do not edit; run `yarn contracts:generate`. */

export type Chunk =
  | {
      [k: string]: unknown
    }
  | string
export type End = boolean
export type Seq = number

/**
 * One item of a large read (``Store/readBlob``, ``Store/exportShare``, ``Client/call``).
 */
export interface StreamChunk {
  chunk: Chunk
  end?: End
  seq: Seq
  [k: string]: unknown
}
