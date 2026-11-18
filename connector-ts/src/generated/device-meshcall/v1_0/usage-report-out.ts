/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact usage-report-out. Do not edit; run `yarn contracts:generate`. */

/**
 * @maxItems 10000
 */
export type Durationsms = number[]
export type Name = string
export type Outcome = string | null
export type Runtimeid = string | null
export type Runtimetype = string | null
export type Sessionid = string | null
export type Value = number
/**
 * @maxItems 1000
 */
export type Counters = UsageCounter[]
export type Periodend = string
export type Periodstart = string
export type Reportid = string

/**
 * ``usage.report``: the device's platform activity since its previous report, as counters (D1: no content).
 *
 * Sent in plaintext in E2EE ``required`` mode too. The Server keys what it records by ``reportId``, so a report
 * the outbox resends counts once. Counters belong to the period's end for hourly statistics.
 */
export interface UsageReportOut {
  counters?: Counters
  periodEnd: Periodend
  periodStart: Periodstart
  reportId: Reportid
  [k: string]: unknown
}
/**
 * How often one platform activity happened in the report's period, per session, runtime and outcome.
 *
 * ``message.sent`` / ``session.created``: messages and sessions the device accepted from the platform (not ones
 * typed into the Agent locally). ``turn.ended``: turns of sessions the platform drives, ``outcome`` ``completed`` /
 * ``interrupted`` / ``failed``. ``approval.requested`` / ``approval.resolved``: approvals, ``outcome`` ``resolved``
 * / ``expired``. ``runtime.error``: errors the Runtime reported. ``durationsMs``: one entry per occurrence whose
 * duration is known (turn: start to end; approval: opened to resolved), at most ``value`` entries.
 */
export interface UsageCounter {
  durationsMs?: Durationsms
  name: Name
  outcome?: Outcome
  runtimeId?: Runtimeid
  runtimeType?: Runtimetype
  sessionId?: Sessionid
  value: Value
  [k: string]: unknown
}
