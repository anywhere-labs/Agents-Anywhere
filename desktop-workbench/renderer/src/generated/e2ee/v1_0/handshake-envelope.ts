/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact handshake-envelope.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

/**
 * base64url without padding
 */
export type Message = string
/**
 * present only for XXpsk0 pairing
 */
export type Pairingid = string | null
export type Pattern = "XXpsk0" | "KK"
export type Step = number

/**
 * Handshake messages ride in ``tun`` frames on a dedicated channel id.
 */
export interface HandshakeEnvelope {
  message: Message
  pairingId?: Pairingid
  pattern: Pattern
  step: Step
  [k: string]: unknown
}
