/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact ws-ticket-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Expiresat = string
export type Servertime = string
export type Ticket = string

export interface ProtocolWsTicketResponse {
  expiresAt: Expiresat
  serverTime: Servertime
  ticket: Ticket
  [k: string]: unknown
}
