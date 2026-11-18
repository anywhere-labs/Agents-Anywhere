/* eslint-disable */
/**
 * Generated from protocol 1.2 artifact supervision-edge.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Createdby = "human" | "agent"
export type State = "active" | "paused" | "ended"
export type Supervisionid = string
export type Supervisorsessionid = string
export type Targetsessionid = string

/**
 * One supervision edge as the session directory keeps it: who watches whom, and its state.
 */
export interface SupervisionEdge {
  createdBy: Createdby
  state: State
  supervisionId: Supervisionid
  supervisorSessionId: Supervisorsessionid
  targetSessionId: Targetsessionid
  [k: string]: unknown
}
