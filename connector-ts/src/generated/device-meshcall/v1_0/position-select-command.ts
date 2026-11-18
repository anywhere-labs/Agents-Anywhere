/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact position-select-command. Do not edit; run `yarn contracts:generate`. */

export type Fileentriesdigest = string
export type Leafid = string | null
export type Positionrevision = number
export type Runtime = string | null
export type Runtimeid = string | null
export type Sessionid = string
export type Sourceepoch = string

/**
 * ``session.position.select``: the leaf of the Agent's session tree the next turn continues from.
 */
export interface PositionSelectCommand {
  fileEntriesDigest: Fileentriesdigest
  leafId?: Leafid
  positionRevision: Positionrevision
  runtime?: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
  sourceEpoch: Sourceepoch
  [k: string]: unknown
}
