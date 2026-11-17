/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact queue-reorder-command. Do not edit; run `yarn contracts:generate`. */

export type Messageids = string[]
export type Runtime = string | null
export type Runtimeid = string | null
export type Sessionid = string

export interface QueueReorderCommand {
  messageIds: Messageids
  runtime?: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
  [k: string]: unknown
}
