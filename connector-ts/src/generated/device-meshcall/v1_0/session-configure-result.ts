/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact session-configure-result. Do not edit; run `yarn contracts:generate`. */

export type Operation = string
export type Title = string
export type Actions = AgentAction[]
export type Category = string
export type Currentvalue = string | boolean
export type Description = string | null
export type Id = string
export type Name = string
export type Options1 = AgentConfigOptionValue[] | null
export type Description1 = string | null
export type Name1 = string
export type Value = string
export type Type = "select" | "boolean"
export type Options = AgentConfigOption[]
export type Revision = number
export type Operationid = string
export type Ownergeneration = string | null
export type Phase = "completed"

export interface SessionConfigureResult {
  actions?: Actions
  configuration: AgentConfiguration
  operationId: Operationid
  ownerGeneration?: Ownergeneration
  phase: Phase
  [k: string]: unknown
}
/**
 * An Agent operation the session can run now, as the configuration panel lists it.
 */
export interface AgentAction {
  operation: Operation
  title: Title
  [k: string]: unknown
}
/**
 * ``revision`` changes whenever the options or their values change.
 */
export interface AgentConfiguration {
  options?: Options
  revision: Revision
  [k: string]: unknown
}
/**
 * One option of the Agent session as the Agent reports it (the same shape as a prepared workspace's).
 */
export interface AgentConfigOption {
  category: Category
  currentValue: Currentvalue
  description?: Description
  id: Id
  name: Name
  options?: Options1
  type: Type
  [k: string]: unknown
}
export interface AgentConfigOptionValue {
  description?: Description1
  name: Name1
  value: Value
  [k: string]: unknown
}
