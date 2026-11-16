/* eslint-disable */
/** Generated from contracts/protocol/1.2 artifact ws-ticket-response. Do not edit; run `yarn contracts:generate`. */

export type Expiresat = string
export type Servertime = string
export type Ticket = string

export interface ProtocolWsTicketResponse {
  expiresAt: Expiresat
  serverTime: Servertime
  ticket: Ticket
  [k: string]: unknown
}
