// Noise 的密码学原语接口（Noise 规范 §4）。实现只能包装成熟库，不在本仓库里实现原语：
// Node 用 node:crypto（OpenSSL），浏览器用 WebCrypto；Kotlin、Swift 两端各有对应实现。
// 套件固定为 25519_AESGCM_SHA256（S8 结论，见 contracts/e2ee/1.0/README.md）。

export const DHLEN = 32
export const HASHLEN = 32
export const KEYLEN = 32
export const TAGLEN = 16
/** Noise 规范 §3：每条消息（握手或传输）最长 65535 字节。 */
export const MAX_MESSAGE_LEN = 65535
/** 2^64 - 1：保留给 rekey，不能用于普通加密。 */
export const MAX_NONCE = (1n << 64n) - 1n

type MaybePromise<T> = T | Promise<T>

/**
 * 一个 X25519 密钥对。私钥可以不暴露（例如浏览器里不可导出的 WebCrypto 密钥），只提供 DH 运算。
 */
export interface NoiseKeyPair {
  readonly publicKey: Uint8Array
  dh(remotePublicKey: Uint8Array): MaybePromise<Uint8Array>
}

export interface NoiseCrypto {
  /** 生成临时密钥对（握手里的 `e`）。 */
  generateKeyPair(): MaybePromise<NoiseKeyPair>
  /** AES-256-GCM；nonce 为 4 字节 0 + 8 字节大端计数器（Noise 规范 §12.4）。返回密文 + 16 字节标签。 */
  encrypt(key: Uint8Array, nonce: bigint, ad: Uint8Array, plaintext: Uint8Array): MaybePromise<Uint8Array>
  /** 认证失败时抛出 {@link NoiseDecryptError}。 */
  decrypt(key: Uint8Array, nonce: bigint, ad: Uint8Array, ciphertext: Uint8Array): MaybePromise<Uint8Array>
  sha256(data: Uint8Array): MaybePromise<Uint8Array>
  hmacSha256(key: Uint8Array, data: Uint8Array): MaybePromise<Uint8Array>
}

export class NoiseError extends Error {
  override readonly name: string = 'NoiseError'
}

/** 认证标签不符：密文被篡改、密钥不对，或 psk 不一致。 */
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
