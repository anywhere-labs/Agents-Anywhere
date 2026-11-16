/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-summary. Do not edit; run `yarn contracts:generate`. */

export type Keyid = string | null
export type Mode = "plain" | "sealed"
export type Payload =
  | {
      [k: string]: unknown
    }
  | string
export type Externalsessionid = string | null
export type Goalstate = "none" | "active" | "paused" | "completed"
export type Headseq = number
export type Lastactivityat = string | null
export type Id = string
export type Role = string | null
export type Status = string | null
export type Time = string | null
export type Type = string
export type Latestturnendseq = number | null
export type Planstate = "none" | "planning" | "awaiting_review"
export type Resetseq = number
export type Runtimeid = string
export type Runtimetype = string
export type Sessionid = string
export type Sortat = string
export type Sourceavailability = "available" | "archived" | "deleted" | "missing" | "unknown"
export type Status1 =
  "idle" | "pending" | "running" | "waiting" | "waiting_approval" | "blocked" | "stopping" | "error" | "unknown"

/**
 * Reported fields of a session directory entry (device is the only writer).
 */
export interface SessionSummary {
  displayDevice: DisplayEnvelope
  externalSessionId?: Externalsessionid
  goalState?: Goalstate
  headSeq: Headseq
  lastActivityAt?: Lastactivityat
  latestItem?: LatestItemFacts | null
  latestTurnEndSeq?: Latestturnendseq
  planState?: Planstate
  resetSeq: Resetseq
  runtimeId: Runtimeid
  runtimeType: Runtimetype
  sessionId: Sessionid
  sortAt: Sortat
  sourceAvailability?: Sourceavailability
  status: Status1
  [k: string]: unknown
}
/**
 * Human-facing content the Server stores but never reads.
 *
 * ``plain``: ``payload`` is a JSON object (normal mode).
 * ``sealed``: ``payload`` is base64 ciphertext encrypted with the device's
 * directory key identified by ``keyId`` (E2EE mode).
 */
export interface DisplayEnvelope {
  keyId?: Keyid
  mode: Mode
  payload: Payload
  [k: string]: unknown
}
/**
 * Scheduling facts about the latest timeline item; no text.
 */
export interface LatestItemFacts {
  id: Id
  role?: Role
  status?: Status
  time?: Time
  type: Type
  [k: string]: unknown
}
