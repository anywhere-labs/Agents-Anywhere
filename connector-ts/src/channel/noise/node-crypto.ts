// Node implementation of NoiseCrypto: every primitive comes from node:crypto (OpenSSL).

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'
import {
  DHLEN,
  NoiseDecryptError,
  NoiseError,
  TAGLEN,
  aesGcmNonce,
  type NoiseCrypto,
  type NoiseKeyPair,
} from './crypto.js'

const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

/** An X25519 key pair holding the raw private key (used for the device identity key once read from the keystore). */
export interface X25519KeyPair extends NoiseKeyPair {
  readonly secretKey: Uint8Array
}

function publicKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== DHLEN) throw new NoiseError(`noise: public key must be ${DHLEN} bytes`)
  return createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, raw]), format: 'der', type: 'spki' })
}

export function x25519FromSecret(secretKey: Uint8Array): X25519KeyPair {
  if (secretKey.length !== DHLEN) throw new NoiseError(`noise: private key must be ${DHLEN} bytes`)
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, secretKey]), format: 'der', type: 'pkcs8' })
  const publicKey = new Uint8Array(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519_PREFIX.length))
  return {
    publicKey,
    secretKey: Uint8Array.from(secretKey),
    dh(remotePublicKey: Uint8Array): Uint8Array {
      try {
        return new Uint8Array(diffieHellman({ privateKey, publicKey: publicKeyObject(remotePublicKey) }))
      } catch (error) {
        // OpenSSL rejects low-order points outright; normalize to NoiseError so behaviour matches the other two platforms.
        if (error instanceof NoiseError) throw error
        throw new NoiseError('noise: invalid DH result')
      }
    },
  }
}

export function generateX25519(): X25519KeyPair {
  const { privateKey } = generateKeyPairSync('x25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' })
  return x25519FromSecret(new Uint8Array(der.subarray(PKCS8_X25519_PREFIX.length)))
}

export const nodeNoiseCrypto: NoiseCrypto = {
  generateKeyPair: generateX25519,
  encrypt(key, nonce, ad, plaintext) {
    const cipher = createCipheriv('aes-256-gcm', key, aesGcmNonce(nonce), { authTagLength: TAGLEN })
    cipher.setAAD(ad)
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return new Uint8Array(Buffer.concat([body, cipher.getAuthTag()]))
  },
  decrypt(key, nonce, ad, ciphertext) {
    if (ciphertext.length < TAGLEN) throw new NoiseDecryptError()
    const decipher = createDecipheriv('aes-256-gcm', key, aesGcmNonce(nonce), { authTagLength: TAGLEN })
    decipher.setAAD(ad)
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN))
    try {
      return new Uint8Array(Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAGLEN)), decipher.final()]))
    } catch {
      throw new NoiseDecryptError()
    }
  },
  sha256(data) {
    return new Uint8Array(createHash('sha256').update(data).digest())
  },
  hmacSha256(key, data) {
    return new Uint8Array(createHmac('sha256', key).update(data).digest())
  },
}
