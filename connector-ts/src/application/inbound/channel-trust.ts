import type { DeviceTrustService } from '../trust/device-trust-service.js'

/**
 * What a secure channel asks of Device Trust: pairing and pinned keys during the handshake, authorization of the
 * caller, the trust requests a client sends over the channel (trust list, list key, revoke, approve), and the
 * trust changes that close channels.
 */
export type ChannelTrust = Pick<
  DeviceTrustService,
  | 'pairingPsk' | 'pinnedKey' | 'completePairing' | 'authorize' | 'state' | 'trustList' | 'directoryKeyGrant' | 'revokeClient' | 'approveClient'
  | 'onEvent' | 'activeClientIds'
>

/** The trust operations available inside a MeshCall content tunnel. */
export type ContentTrust = Pick<DeviceTrustService,
  'state' | 'authorize' | 'commitMeshPairing' | 'directoryKeyGrant' | 'trustList' | 'revokeClient' | 'onEvent'>
