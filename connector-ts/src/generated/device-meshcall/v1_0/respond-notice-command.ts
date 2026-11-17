/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact respond-notice-command. Do not edit; run `yarn contracts:generate`. */

export type Actionid = string | null
export type Cancel = boolean | null
export type Noticeid = string
export type Responseid = string | null
export type Runtime = string | null
export type Runtimeid = string | null
export type Sessionid = string

/**
 * An approval option (``actionId``), form ``input``, or ``cancel``; ``responseId`` defaults to the commandId.
 */
export interface RespondNoticeCommand {
  actionId?: Actionid
  cancel?: Cancel
  input?: Input
  noticeId: Noticeid
  responseId?: Responseid
  runtime?: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
  [k: string]: unknown
}
export interface Input {
  [k: string]: unknown
}
