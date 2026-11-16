/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact channel-close.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Kind = "close"
export type Message = string
export type Reason = "revoked" | "not_paired" | "policy" | "shutdown" | "protocol_error" | "too_large"

export interface ChannelClose {
  kind?: Kind
  message?: Message
  reason: Reason
  [k: string]: unknown
}
