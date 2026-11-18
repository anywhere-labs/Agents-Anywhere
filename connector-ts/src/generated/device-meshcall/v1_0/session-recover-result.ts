/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-recover-result. Do not edit; run `yarn contracts:generate`. */

export type Operationid = string
export type Phase = "completed"
export type State = {
  [k: string]: unknown
} | null

export interface SessionRecoverResult {
  operationId: Operationid
  phase: Phase
  state?: State
  [k: string]: unknown
}
