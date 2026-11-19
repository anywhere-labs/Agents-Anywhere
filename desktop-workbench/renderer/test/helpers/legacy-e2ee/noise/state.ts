// CipherState 与 SymmetricState（Noise 规范 §5.1、§5.2）。

import {
  HASHLEN,
  KEYLEN,
  MAX_NONCE,
  NoiseError,
  TAGLEN,
  concatBytes,
  type NoiseCrypto,
} from '../../../../src/lib/e2ee/noise/crypto'

const EMPTY = new Uint8Array(0)
const ZERO_KEY = new Uint8Array(KEYLEN)

export class CipherState {
  #key: Uint8Array | null = null
  #nonce = 0n

  constructor(
    private readonly crypto: NoiseCrypto,
    key: Uint8Array | null = null,
  ) {
    if (key) this.initializeKey(key)
  }

  initializeKey(key: Uint8Array): void {
    if (key.length !== KEYLEN) throw new NoiseError(`noise: key must be ${KEYLEN} bytes`)
    this.#key = Uint8Array.from(key)
    this.#nonce = 0n
  }

  hasKey(): boolean {
    return this.#key !== null
  }

  /** 下一条消息要用的计数器，也就是已经处理过的消息条数。 */
  get nonce(): bigint {
    return this.#nonce
  }

  /** 只用于测试与恢复：Noise 规范 §5.1 SetNonce。 */
  setNonce(nonce: bigint): void {
    if (nonce < 0n || nonce >= MAX_NONCE) throw new NoiseError('noise: nonce out of range')
    this.#nonce = nonce
  }

  async encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.#key) return Uint8Array.from(plaintext)
    if (this.#nonce >= MAX_NONCE) throw new NoiseError('noise: nonce exhausted')
    const out = await this.crypto.encrypt(this.#key, this.#nonce, ad, plaintext)
    this.#nonce += 1n
    return out
  }

  async decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    if (!this.#key) return Uint8Array.from(ciphertext)
    if (this.#nonce >= MAX_NONCE) throw new NoiseError('noise: nonce exhausted')
    if (ciphertext.length < TAGLEN) throw new NoiseError('noise: ciphertext shorter than tag')
    // 认证失败时计数器不前进（规范 §5.1）。
    const out = await this.crypto.decrypt(this.#key, this.#nonce, ad, ciphertext)
    this.#nonce += 1n
    return out
  }

  /** Noise 规范 §4.2 REKEY：k = ENCRYPT(k, 2^64-1, "", zeros)[0:32]；计数器不变。 */
  async rekey(): Promise<void> {
    if (!this.#key) throw new NoiseError('noise: rekey without key')
    const out = await this.crypto.encrypt(this.#key, MAX_NONCE, EMPTY, ZERO_KEY)
    this.#key = out.slice(0, KEYLEN)
  }

  /** 用后清零。 */
  destroy(): void {
    this.#key?.fill(0)
    this.#key = null
  }
}

export class SymmetricState {
  readonly cipher: CipherState
  #ck: Uint8Array
  #h: Uint8Array

  private constructor(
    private readonly crypto: NoiseCrypto,
    h: Uint8Array,
  ) {
    this.cipher = new CipherState(crypto)
    this.#h = h
    this.#ck = Uint8Array.from(h)
  }

  static async initialize(crypto: NoiseCrypto, protocolName: string): Promise<SymmetricState> {
    const name = new TextEncoder().encode(protocolName)
    let h: Uint8Array
    if (name.length <= HASHLEN) {
      h = new Uint8Array(HASHLEN)
      h.set(name)
    } else {
      h = await crypto.sha256(name)
    }
    return new SymmetricState(crypto, h)
  }

  get handshakeHash(): Uint8Array {
    return Uint8Array.from(this.#h)
  }

  async mixKey(ikm: Uint8Array): Promise<void> {
    const [ck, tempK] = await this.#hkdf(ikm, 2)
    this.#ck = ck!
    this.cipher.initializeKey(tempK!)
  }

  async mixHash(data: Uint8Array): Promise<void> {
    this.#h = await this.crypto.sha256(concatBytes(this.#h, data))
  }

  async mixKeyAndHash(ikm: Uint8Array): Promise<void> {
    const [ck, tempH, tempK] = await this.#hkdf(ikm, 3)
    this.#ck = ck!
    await this.mixHash(tempH!)
    this.cipher.initializeKey(tempK!)
  }

  async encryptAndHash(plaintext: Uint8Array): Promise<Uint8Array> {
    const ciphertext = await this.cipher.encryptWithAd(this.#h, plaintext)
    await this.mixHash(ciphertext)
    return ciphertext
  }

  async decryptAndHash(ciphertext: Uint8Array): Promise<Uint8Array> {
    const plaintext = await this.cipher.decryptWithAd(this.#h, ciphertext)
    await this.mixHash(ciphertext)
    return plaintext
  }

  async split(): Promise<[CipherState, CipherState]> {
    const [k1, k2] = await this.#hkdf(EMPTY, 2)
    const first = new CipherState(this.crypto, k1!)
    const second = new CipherState(this.crypto, k2!)
    this.#ck.fill(0)
    this.cipher.destroy()
    return [first, second]
  }

  /** Noise 规范 §4.3 HKDF（HMAC-SHA256），输出 2 或 3 段，各 32 字节。 */
  async #hkdf(ikm: Uint8Array, outputs: 2 | 3): Promise<Uint8Array[]> {
    const tempKey = await this.crypto.hmacSha256(this.#ck, ikm)
    const out1 = await this.crypto.hmacSha256(tempKey, Uint8Array.of(0x01))
    const out2 = await this.crypto.hmacSha256(tempKey, concatBytes(out1, Uint8Array.of(0x02)))
    if (outputs === 2) return [out1, out2]
    const out3 = await this.crypto.hmacSha256(tempKey, concatBytes(out2, Uint8Array.of(0x03)))
    return [out1, out2, out3]
  }
}
