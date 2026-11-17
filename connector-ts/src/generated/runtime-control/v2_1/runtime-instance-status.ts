/* eslint-disable */
/** Generated from contracts/runtime-control/2.1 artifact runtime-instance-status. Do not edit; run `yarn contracts:generate`. */

/**
 * Current persisted lifecycle state for a runtime instance.
 */
export type RuntimeInstanceStatus = {
  [k: string]: unknown
} & {
  /**
   * The user's desired active state. It may remain true while status is error.
   */
  active: boolean
  configured: boolean
  createdAt: string
  error: RuntimeError | null
  name: string
  /**
   * Present while a lifecycle status has a finer-grained step the user should see (for example `syncing` during `starting`). Null or absent otherwise.
   */
  phase?: RuntimePhase | null
  runtimeId: string
  runtimeType: string
  startedAt: string | null
  status: "stopped" | "validating" | "starting" | "running" | "stopping" | "error" | "unknown"
  stoppedAt: string | null
  updatedAt: string
}

/**
 * A stable machine code and human-readable message, with optional provider details preserved.
 */
export interface RuntimeError {
  code: string
  details?: {
    [k: string]: unknown
  }
  message: string
  retryable?: boolean
  [k: string]: unknown
}
/**
 * A sub-step of a lifecycle status, e.g. an instance that is `starting` while it synchronizes sessions. It is informational: the status itself still decides what the instance can do.
 */
export interface RuntimePhase {
  code: string
  message: string
  retryable?: boolean
  [k: string]: unknown
}
