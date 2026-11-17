/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact usage-report-out. Do not edit; run `yarn contracts:generate`. */

export type Name = string
export type Runtimeid = string | null
export type Sessionid = string | null
export type Value = number
export type Counters = UsageCounter[]
export type Periodend = string
export type Periodstart = string

export interface UsageReportOut {
  counters?: Counters
  periodEnd: Periodend
  periodStart: Periodstart
  [k: string]: unknown
}
export interface UsageCounter {
  name: Name
  runtimeId?: Runtimeid
  sessionId?: Sessionid
  value: Value
  [k: string]: unknown
}
