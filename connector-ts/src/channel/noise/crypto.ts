// Interface for Noise cryptographic primitives (Noise spec §4). Implementations only wrap mature libraries; primitives are never implemented in this repository:
// Node uses node:crypto (OpenSSL), browsers use WebCrypto; Kotlin and Swift each have their own implementation.
// The suite is fixed to 25519_AESGCM_SHA256 (decided in S8, see contracts/e2ee/1.0/README.md).

export const DHLEN = 32
export const HASHLEN = 32
export const KEYLEN = 32
export const TAGLEN = 16
/** Noise spec §3: every message (handshake or transport) is at most 65535 bytes. */
export const MAX_MESSAGE_LEN = 65535
/** 2^64 - 1: reserved for rekey, never used for ordinary encryption. */
export const MAX_NONCE = (1n << 64n) - 1n

type MaybePromise<T> = T | Promise<T>

/**
 * An X25519 key pair. The private key need not be exposed (e.g. a non-extractable WebCrypto key in a browser); only DH is provided.
 */
export interface NoiseKeyPair {
  readonly publicKey: Uint8Array
  dh(remotePublicKey: Uint8Array): MaybePromise<Uint8Array>
}

export interface NoiseCrypto {
  /** Generates an ephemeral key pair (the handshake's `e`). */
  generateKeyPair(): MaybePromise<NoiseKeyPair>
  /** AES-256-GCM; the nonce is 4 zero bytes + an 8-byte big-endian counter (Noise spec §12.4). Returns ciphertext + 16-byte tag. */
  encrypt(key: Uint8Array, nonce: bigint, ad: Uint8Array, plaintext: Uint8Array): MaybePromise<Uint8Array>
  /** Throws {@link NoiseDecryptError} when authentication fails. */
  decrypt(key: Uint8Array, nonce: bigint, ad: Uint8Array, ciphertext: Uint8Array): MaybePromise<Uint8Array>
  sha256(data: Uint8Array): MaybePromise<Uint8Array>
  hmacSha256(key: Uint8Array, data: Uint8Array): MaybePromise<Uint8Array>
}

export class NoiseError extends Error {
  override readonly name: string = 'NoiseError'
}

/** Authentication tag mismatch: the ciphertext was tampered with, the key is wrong, or the psk differs. */
export class NoiseDecryptError extends NoiseError {
  override readonly name = 'NoiseDecryptError'
  constructor(message = 'noise: decryption failed') {
    super(message)
  }
}

export function aesGcmNonce(n: bigint): Uint8Array {
  if (n < 0n || n > MAX_NONCE) throw new NoiseError(`noise: nonce out of range: ${n}`)
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, n, false)
  return nonce
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0
  for (const byte of bytes) acc |= byte
  return acc === 0
}
