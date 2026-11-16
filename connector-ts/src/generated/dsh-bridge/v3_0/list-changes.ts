/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact list-changes. Do not edit; run `yarn contracts:generate`. */

/**
 * _session/list/changes notification params (§4).
 */
export interface DshListChanges {
  upserts: {
    sessionId: string
    cwd: string
    title?: string | null
    updatedAt?: string | null
    _meta?: {
      dsh: DshSessionInfoMeta
      [k: string]: unknown
    }
    [k: string]: unknown
  }[]
  removals: string[]
}
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
