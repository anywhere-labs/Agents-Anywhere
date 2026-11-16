/* eslint-disable */
/** Generated from contracts/dsh-bridge/3.0 artifact update-meta. Do not edit; run `yarn contracts:generate`. */

/**
 * session/update update._meta.dsh (§6).
 */
export interface DshUpdateMeta {
  seq?: number
  turn?: number
  /**
   * DSH step of the turn; with turn it names the assistant item a stream attempt and its committed message share.
   */
  step?: number
  /**
   * Stable timeline item of this update: the same for a stream attempt, its committed message and their replay (§6).
   */
  itemId?: string
  transient?: boolean
  attemptId?: string
  committed?: {
    messageId: string
    replacesAttempt?: string
  }
  abandoned?: {
    attemptId: string
  }
  source?: "user" | "retry" | "other"
  requestId?: string
  /**
   * update._meta.dsh.turnEvent of a session_info_update (§7).
   */
  turnEvent?:
    | {
        sessionId: string
        phase: "started"
        turn: number
        seq: number
        requestIds?: string[]
      }
    | {
        sessionId: string
        phase: "ended"
        turn: number
        seq: number
        stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
        reason: {
          kind: string
          message?: string
          [k: string]: unknown
        }
        continuable: boolean
        /**
         * rpcIds of the user inputs this turn consumed
         */
        requestIds: string[]
      }
  /**
   * On session_info_update: the session's writer changed (§9).
   */
  writer?: "host" | "external" | "none"
}
