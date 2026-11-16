/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact pairing-payload. Do not edit; run `yarn contracts:generate`. */

export type Deviceid = string
/**
 * 32 bytes, base64url without padding
 */
export type Deviceidentitypub = string
export type E2Eemode = "off" | "required"
export type Expiresat = string
export type Pairingid = string
/**
 * 32 random bytes, single use, expires after 10 minutes
 */
export type Psk = string
export type Serverurl = string
export type V = 1

/**
 * Encoded in the QR code shown by the device: ``aa-pair://<base64url(json)>``.
 */
export interface PairingPayload {
  deviceId: Deviceid
  deviceIdentityPub: Deviceidentitypub
  e2eeMode: E2Eemode
  expiresAt: Expiresat
  pairingId: Pairingid
  psk: Psk
  serverUrl: Serverurl
  v?: V
  [k: string]: unknown
}
