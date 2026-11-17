/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact export-share-request. Do not edit; run `yarn contracts:generate`. */

export type Bytebudget = number
export type Itemids = string[]
export type Scope = string
export type Sessionid = string

/**
 * ``Store/exportShare``: an immutable snapshot of the selected items.
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
