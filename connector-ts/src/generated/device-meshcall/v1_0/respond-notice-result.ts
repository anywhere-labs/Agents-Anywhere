/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact respond-notice-result. Do not edit; run `yarn contracts:generate`. */

export type Code = string | null
export type Message = string | null
export type Ok = boolean | null
export type Status = string

/**
 * ``ok: false`` with ``code``/``message``: the Runtime declined the answer and nothing ran (``status`` says
 * whether the notice is still open or expired).
 */
export interface RespondNoticeResult {
  code?: Code
  message?: Message
  ok?: Ok
  status: Status
  [k: string]: unknown
}
