/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact agent-operation-result. Do not edit; run `yarn contracts:generate`. */

export type Code = string
export type Message = string
export type Operationid = string
export type Phase = "accepted" | "running" | "completed" | "rejected" | "cancelled" | "outcome_unknown"
export type Result = {
  [k: string]: unknown
} | null

export interface AgentOperationResult {
  failure?: WorkflowFailure | null
  operationId: Operationid
  phase: Phase
  result?: Result
  [k: string]: unknown
}
export interface WorkflowFailure {
  code: Code
  message: Message
  [k: string]: unknown
}
