/* eslint-disable */
/** Generated from contracts/e2ee/1.0 artifact pairing-device-hello. Do not edit; run `yarn contracts:generate`. */

export type Deviceid = string
export type Label = string

/**
 * Payload of XXpsk0 message 2 (device -> client). The client checks ``deviceId`` and that the
 * static key in the same message equals ``PairingPayload.deviceIdentityPub``.
 */
export interface PairingDeviceHello {
  deviceId: Deviceid
  label?: Label
  [k: string]: unknown
}
