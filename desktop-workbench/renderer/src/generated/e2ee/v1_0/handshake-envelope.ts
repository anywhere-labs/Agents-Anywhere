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
 * A Noise handshake message. While a channel handshakes, ``ct`` of its frames is
 * ``base64url(utf8(json(HandshakeEnvelope)))`` and ``n`` is ``step``; afterwards ``ct`` is a
 * Noise transport message and ``n`` its nonce.
 */
export interface HandshakeEnvelope {
  message: Message
  pairingId?: Pairingid
  pattern: Pattern
  step: Step
  [k: string]: unknown
}
