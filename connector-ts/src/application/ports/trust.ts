import type { DeviceTrustState } from '../../domain/trust/index.js'

/**
 * Ports of the Trust use cases (docs/v3/11-e2ee-noise.md §2). Implemented by `keystore/` (secrets, trust list) and
 * `channel/` (sealing); `entry/` wires them.
 */

/** Persists the trust list. Not secret (public keys and names) but must not be editable by anything but the device. */
export interface TrustRepository {
  load(): Promise<DeviceTrustState | null>
  save(state: DeviceTrustState): Promise<void>
}

/** The device's secrets. Never exported, never in a backup (§4.1 invariant 4). */
export interface DeviceSecrets {
  /** The long-term X25519 identity key; created on first use. */
  identityKey(): Promise<{ readonly publicKey: Uint8Array; readonly secretKey: Uint8Array }>
  directoryKey(keyId: string): Promise<Uint8Array | null>
  putDirectoryKey(keyId: string, key: Uint8Array): Promise<void>
  deleteDirectoryKey(keyId: string): Promise<void>
}

/** Same shape as A's `Clock`; kept separate so Trust does not depend on Conversation ports. */
export interface TrustClock {
  nowIso(): string
  nowMs(): number
}

export interface TrustRandom {
  bytes(length: number): Uint8Array
  /** A random id with the given prefix (`pair_`, `dk_`). */
  id(prefix: string): string
}

/** Asks the person at this device to confirm something (Desktop dialog, interactive CLI). */
export interface LocalConfirmation {
  confirmClientApproval(request: {
    readonly approverLabel: string
    readonly label: string
    readonly fingerprint: string
  }): Promise<boolean>
}

/** AES-256-GCM with associated data; the implementation lives in `channel/` (node:crypto or WebCrypto). */
export interface ContentSealer {
  /** Returns base64url(nonce12 ‖ ciphertext ‖ tag) with a fresh random nonce. */
  seal(key: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Promise<string>
  /** Throws when the tag does not verify. */
  open(key: Uint8Array, ad: Uint8Array, sealed: string): Promise<Uint8Array>
}
