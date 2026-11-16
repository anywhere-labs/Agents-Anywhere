/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact session-info-meta. Do not edit; run `yarn contracts:generate`. */

/**
 * _meta.dsh of a session/list entry or _session/list/changes upsert (§4).
 */
export interface DshSessionInfoMeta {
  createdAt?: string
  running: boolean
  lastSeq: number
  workspaceId?: string
  /**
   * Who holds the DSH session write lock (§9).
   */
  writer: "host" | "external" | "none"
}
