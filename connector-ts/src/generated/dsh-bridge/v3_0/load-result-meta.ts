/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact load-result-meta. Do not edit; run `yarn contracts:generate`. */

/**
 * session/load and session/resume result _meta.dsh (§5).
 */
export interface DshLoadResultMeta {
  lastSeq: number
  running: boolean
  /**
   * turn/end seq that _dsh/session/continue may continue, or null
   */
  continuable: number | null
  replayTruncated?: boolean
  /**
   * Who holds the DSH session write lock (§9).
   */
  writer: "host" | "external" | "none"
}
