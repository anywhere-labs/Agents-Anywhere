/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact writer-notification. Do not edit; run `yarn contracts:generate`. */

/**
 * _dsh/session/writer notification params (§9).
 */
export interface DshWriterNotification {
  sessionId: string
  /**
   * Who holds the DSH session write lock (§9).
   */
  writer: "host" | "external" | "none"
  /**
   * the DSH UI is waiting for the external writer to release
   */
  waiting?: boolean
}
