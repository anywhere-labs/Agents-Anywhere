/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact store-read-response. Do not edit; run `yarn contracts:generate`. */

export type Hasmore = boolean
export type Headseq = number
export type Items = {
  [k: string]: unknown
}[]
export type Oldestorderseq = number | null
export type Resetseq = number

export interface StoreReadResponse {
  hasMore: Hasmore
  headSeq: Headseq
  items?: Items
  oldestOrderSeq?: Oldestorderseq
  resetSeq: Resetseq
  [k: string]: unknown
}
