/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact preparation-reserve-result. Do not edit; run `yarn contracts:generate`. */

export type Code = string
export type Message = string
export type Reserved = boolean

/**
 * ``reserved: false`` always carries the ``failure`` the creation is rejected with.
 */
export interface PreparationReserveResult {
  failure?: WorkflowFailure | null
  reserved: Reserved
  [k: string]: unknown
}
export interface WorkflowFailure {
  code: Code
  message: Message
  [k: string]: unknown
}
