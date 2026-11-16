/* eslint-disable */
/** Generated from contracts/protocol/1.2 artifact ws-ticket-request. Do not edit; run `yarn contracts:generate`. */

export type Clientid = string
export type Dashboard = boolean
export type Sessionid = string | null

export interface ProtocolWsTicketRequest {
  clientId: Clientid
  scope: ProtocolWsTicketScope
  [k: string]: unknown
}
export interface ProtocolWsTicketScope {
  dashboard?: Dashboard
  sessionId?: Sessionid
  [k: string]: unknown
}
