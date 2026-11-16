// NoiseCrypto over WebCrypto (browsers, the Electron renderer and Node 22 for tests). Primitives only come from
// `crypto.subtle`; the Noise state machine is ./noise. Suite: 25519_AESGCM_SHA256 (contracts/e2ee/1.0, S8).

import { buf } from "./bytes"
import { DHLEN, NoiseDecryptError, NoiseError, TAGLEN, aesGcmNonce, isAllZero, type NoiseCrypto, type NoiseKeyPair } from "./noise"

const subtle = (): SubtleCrypto => {
  const value = globalThis.crypto?.subtle
  if (!value) throw new NoiseError("noise: WebCrypto is not available (needs a secure context)")
  return value
}

const X25519 = { name: "X25519" } as const

async function importPublic(publicKey: Uint8Array): Promise<CryptoKey> {
  if (publicKey.length !== DHLEN) throw new NoiseError(`noise: public key must be ${DHLEN} bytes`)
  return subtle().importKey("raw", buf(publicKey), X25519, true, [])
}

/** A key pair whose private half is a CryptoKey (non-extractable when it comes from {@link generateIdentity}). */
export async function keyPairFromCryptoKeys(keys: CryptoKeyPair): Promise<NoiseKeyPair> {
  const publicKey = new Uint8Array(await subtle().exportKey("raw", keys.publicKey))
  return {
    publicKey,
    async dh(remote: Uint8Array) {
      const shared = new Uint8Array(
        await subtle().deriveBits({ name: "X25519", public: await importPublic(remote) }, keys.privateKey, DHLEN * 8),
      )
      if (isAllZero(shared)) throw new NoiseError("noise: low-order public key")
      return shared
    },
  }
}

/** The client identity: private key never leaves WebCrypto (stored as a CryptoKey in IndexedDB). */
export async function generateIdentity(): Promise<CryptoKeyPair> {
  return (await subtle().generateKey(X25519, false, ["deriveBits"])) as CryptoKeyPair
}

/** Tests and vectors only: a key pair from raw private bytes (PKCS#8 import). */
export async function keyPairFromSecret(secret: Uint8Array): Promise<NoiseKeyPair> {
  if (secret.length !== DHLEN) throw new NoiseError(`noise: private key must be ${DHLEN} bytes`)
  const pkcs8 = new Uint8Array(48)
  pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20])
  pkcs8.set(secret, 16)
  const privateKey = await subtle().importKey("pkcs8", pkcs8, X25519, true, ["deriveBits"])
  const jwk = await subtle().exportKey("jwk", privateKey)
  const publicKey = await subtle().importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, X25519, true, [])
  return keyPairFromCryptoKeys({ privateKey, publicKey })
}

async function aesKey(key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return subtle().importKey("raw", buf(key), { name: "AES-GCM" }, false, [usage])
}

export async function gcmEncrypt(key: Uint8Array | CryptoKey, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = key instanceof Uint8Array ? await aesKey(key, "encrypt") : key
  return new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(ad), tagLength: TAGLEN * 8 }, cryptoKey, buf(plaintext)),
  )
}

export async function gcmDecrypt(key: Uint8Array | CryptoKey, nonce: Uint8Array, ad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < TAGLEN) throw new NoiseDecryptError()
  const cryptoKey = key instanceof Uint8Array ? await aesKey(key, "decrypt") : key
  try {
    return new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(ad), tagLength: TAGLEN * 8 }, cryptoKey, buf(sealed)),
    )
  } catch {
    throw new NoiseDecryptError()
  }
}

export async function hmacSha256(key: Uint8Array | CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey =
    key instanceof Uint8Array ? await subtle().importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]) : key
  return new Uint8Array(await subtle().sign("HMAC", cryptoKey, buf(data)))
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", buf(data)))
}

export function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

export const webNoiseCrypto: NoiseCrypto = {
  async generateKeyPair() {
    return keyPairFromCryptoKeys((await subtle().generateKey(X25519, false, ["deriveBits"])) as CryptoKeyPair)
  },
  encrypt: (key, nonce, ad, plaintext) => gcmEncrypt(key, aesGcmNonce(nonce), ad, plaintext),
  decrypt: (key, nonce, ad, ciphertext) => gcmDecrypt(key, aesGcmNonce(nonce), ad, ciphertext),
  sha256,
  hmacSha256,
}
