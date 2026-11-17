/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact creation-cancel-command. Do not edit; run `yarn contracts:generate`. */

export type Canceloperationid = string | null
export type Createoperationid = string
export type Runtime = string | null
export type Runtimeid = string

export interface CreationCancelCommand {
  cancelOperationId?: Canceloperationid
  createOperationId: Createoperationid
  runtime?: Runtime
  runtimeId: Runtimeid
  [k: string]: unknown
}
