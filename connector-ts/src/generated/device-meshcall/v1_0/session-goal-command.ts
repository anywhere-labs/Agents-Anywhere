/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-goal-command. Do not edit; run `yarn contracts:generate`. */

export type Action = "set" | "edit" | "pause" | "resume" | "clear"
/**
 * @maxItems 100
 */
export type Attachments = {
  [k: string]: unknown
}[]
export type Expectedrevision = number
export type Objective = string | null
export type Operationid = string
export type Sessionid = string

/**
 * ``session.goal``: the client's goal request on ``sessionId``.
 */
export interface SessionGoalCommand {
  action: Action
  attachments?: Attachments
  expectedRevision: Expectedrevision
  objective?: Objective
  operationId: Operationid
  sessionId: Sessionid
}
