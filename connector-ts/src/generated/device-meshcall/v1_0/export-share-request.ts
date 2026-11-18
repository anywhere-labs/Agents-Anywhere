/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact export-share-request. Do not edit; run `yarn contracts:generate`. */

export type Bytebudget = number
export type Itemids = string[]
export type Scope = string
export type Sessionid = string

/**
 * ``Store/exportShare``: an immutable snapshot of the selected items.
 *
 * ``byteBudget`` bounds the serialized items of the whole snapshot; a larger selection is refused with
 * ``share_too_large`` rather than cut. Each stream chunk stays below the Router frame on its own.
 */
export interface ExportShareRequest {
  byteBudget?: Bytebudget
  selection: ShareSelection
  sessionId: Sessionid
  [k: string]: unknown
}
export interface ShareSelection {
  itemIds?: Itemids
  scope: Scope
  [k: string]: unknown
}
