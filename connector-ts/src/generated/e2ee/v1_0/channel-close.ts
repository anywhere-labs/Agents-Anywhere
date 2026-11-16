/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact channel-close. Do not edit; run `yarn contracts:generate`. */

export type Kind = "close"
export type Message = string
export type Reason = "revoked" | "not_paired" | "policy" | "shutdown" | "protocol_error" | "too_large"

export interface ChannelClose {
  kind?: Kind
  message?: Message
  reason: Reason
  [k: string]: unknown
}
