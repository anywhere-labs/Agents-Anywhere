/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact collab-signal-command. Do not edit; run `yarn contracts:generate`. */

/**
 * @minItems 1
 * @maxItems 100
 */
export type Signals = [CollabTargetSignal, ...CollabTargetSignal[]]
export type At = string
export type Deviceonline = boolean
export type Goalstate = "none" | "active" | "paused" | "completed"
export type Headseq = number
export type Latestturnendseq = number | null
export type Planstate = "none" | "planning" | "awaiting_review"
export type Resetseq = number
export type Status =
  "idle" | "pending" | "running" | "waiting" | "waiting_approval" | "blocked" | "stopping" | "error" | "unknown"
export type Supervisionid = string
export type Supervisorsessionid = string
export type Targetdeviceid = string
export type Targetsessionid = string

/**
 * ``collab.signal``: target signals for supervisions this device holds. Lossy and idempotent: a later
 * signal for the same target supersedes an earlier one.
 */
export interface CollabSignalCommand {
  signals: Signals
  [k: string]: unknown
}
/**
 * A supervised session's directory-level change, forwarded to the supervisor's device. Scheduling fields
 * only (plaintext in both modes).
 */
export interface CollabTargetSignal {
  at: At
  deviceOnline?: Deviceonline
  goalState?: Goalstate
  headSeq: Headseq
  latestTurnEndSeq?: Latestturnendseq
  planState?: Planstate
  resetSeq?: Resetseq
  status: Status
  supervisionId: Supervisionid
  supervisorSessionId: Supervisorsessionid
  targetDeviceId: Targetdeviceid
  targetSessionId: Targetsessionid
  [k: string]: unknown
}
