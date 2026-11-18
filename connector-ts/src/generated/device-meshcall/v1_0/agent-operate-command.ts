/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact agent-operate-command. Do not edit; run `yarn contracts:generate`. */

export type Expectedgeneration = string
export type Operation = string
export type Operationid = string
export type Runtime = string | null
export type Runtimeid = string | null
export type Sessionid = string

/**
 * ``session.agent.operate``: an operation the Agent declares a capability for (``AgentOperationRequest``).
 */
export interface AgentOperateCommand {
  expectedGeneration: Expectedgeneration
  operation: Operation
  operationId: Operationid
  runtime?: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
  values?: Values
  [k: string]: unknown
}
export interface Values {
  [k: string]: unknown
}
