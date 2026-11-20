/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact collab-supervision-out. Do not edit; run `yarn contracts:generate`. */

export type At = string
export type Createdby = "human" | "agent"
export type State = "active" | "paused" | "ended"
export type Supervisionid = string
export type Supervisorsessionid = string
export type Targetdeviceid = string
export type Targetsessionid = string

/**
 * ``collab.supervision.changed``: a supervision edge the supervisor's device created or changed. Ids and
 * state only; triggers, authority and digests stay on the device.
 */
export interface CollabSupervisionOut {
  at: At
  createdBy: Createdby
  state: State
  supervisionId: Supervisionid
  supervisorSessionId: Supervisorsessionid
  targetDeviceId: Targetdeviceid
  targetSessionId: Targetsessionid
  [k: string]: unknown
}
