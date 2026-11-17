// HandshakeState (Noise spec §5.3). Only reads and writes handshake messages and performs Split; authorization decisions live above (Device / Client Trust).

import {
  DHLEN,
  MAX_MESSAGE_LEN,
  NoiseError,
  concatBytes,
  isAllZero,
  type NoiseCrypto,
  type NoiseKeyPair,
} from './crypto.js'
import { parseProtocolName, type HandshakePattern, type Token } from './patterns.js'
import { CipherState, SymmetricState } from './state.js'

export interface HandshakeOptions {
  readonly crypto: NoiseCrypto
  /** e.g. `Noise_XXpsk0_25519_AESGCM_SHA256` */
  readonly protocolName: string
  readonly initiator: boolean
  readonly prologue?: Uint8Array
  /** Local static key (long-term X25519). */
  readonly s?: NoiseKeyPair
  /** Test vectors only: a fixed ephemeral key. Production code lets crypto generate it. */
  readonly e?: NoiseKeyPair
  /** Remote static public key known in advance (both sides of KK; the device public key a client gets from the QR code when pairing is checked afterwards and does not go here). */
  readonly rs?: Uint8Array
  readonly re?: Uint8Array
  readonly psks?: readonly Uint8Array[]
}

export interface TransportPair {
  /** For sending from this side. */
  readonly send: CipherState
  /** For receiving on this side. */
  readonly receive: CipherState
  readonly handshakeHash: Uint8Array
  /** The remote static public key authenticated in the handshake (the KK pre-message or the XX `s`). */
  readonly remoteStatic: Uint8Array | null
}

export class HandshakeState {
  readonly pattern: HandshakePattern
  readonly initiator: boolean
  readonly #crypto: NoiseCrypto
  readonly #symmetric: SymmetricState
  readonly #s: NoiseKeyPair | null
  #e: NoiseKeyPair | null
  #rs: Uint8Array | null
  #re: Uint8Array | null
  readonly #psks: Uint8Array[]
  readonly #pskMode: boolean
  #index = 0
  #result: TransportPair | null = null
  #failed = false

  private constructor(options: HandshakeOptions, pattern: HandshakePattern, symmetric: SymmetricState) {
    this.pattern = pattern
    this.initiator = options.initiator
    this.#crypto = options.crypto
    this.#symmetric = symmetric
    this.#s = options.s ?? null
    this.#e = options.e ?? null
    this.#rs = options.rs ? Uint8Array.from(options.rs) : null
    this.#re = options.re ? Uint8Array.from(options.re) : null
    this.#psks = (options.psks ?? []).map((psk) => Uint8Array.from(psk))
    this.#pskMode = pattern.messages.some((tokens) => tokens.includes('psk'))
  }

  static async create(options: HandshakeOptions): Promise<HandshakeState> {
    const { pattern } = parseProtocolName(options.protocolName)
    const pskCount = pattern.messages.flat().filter((token) => token === 'psk').length
    const psks = options.psks ?? []
    if (psks.length !== pskCount) throw new NoiseError(`noise: ${pattern.name} needs ${pskCount} psk(s), got ${psks.length}`)
    for (const psk of psks) if (psk.length !== 32) throw new NoiseError('noise: psk must be 32 bytes')
    for (const key of [options.rs, options.re]) {
      if (key && key.length !== DHLEN) throw new NoiseError(`noise: public key must be ${DHLEN} bytes`)
    }

    const symmetric = await SymmetricState.initialize(options.crypto, options.protocolName)
    const state = new HandshakeState(options, pattern, symmetric)
    await symmetric.mixHash(options.prologue ?? new Uint8Array(0))
    const [initiatorPre, responderPre] = pattern.preMessages
    await state.#mixPreMessage(initiatorPre, options.initiator)
    await state.#mixPreMessage(responderPre, !options.initiator)
    return state
  }

  /** Whether the handshake has finished (Split done). */
  get isComplete(): boolean {
    return this.#result !== null
  }

  /** Whether this side writes the next message. */
  get isMyTurn(): boolean {
    return this.#index % 2 === (this.initiator ? 0 : 1)
  }

  get handshakeHash(): Uint8Array {
    return this.#symmetric.handshakeHash
  }

  get remoteStatic(): Uint8Array | null {
    return this.#rs ? Uint8Array.from(this.#rs) : null
  }

  /** After the handshake, takes the two CipherStates for transport; can be taken only once. */
  takeTransport(): TransportPair {
    const result = this.#result
    if (!result) throw new NoiseError('noise: handshake not complete')
    this.#result = null
    return result
  }

  async writeMessage(payload: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
    const tokens = this.#nextTokens(true)
    try {
      const parts: Uint8Array[] = []
      for (const token of tokens) {
        switch (token) {
          case 'e': {
            if (!this.#e) this.#e = await this.#crypto.generateKeyPair()
            const pub = this.#e.publicKey
            parts.push(pub)
            await this.#symmetric.mixHash(pub)
            if (this.#pskMode) await this.#symmetric.mixKey(pub)
            break
          }
          case 's':
            parts.push(await this.#symmetric.encryptAndHash(this.#requireS().publicKey))
            break
          case 'psk':
            await this.#symmetric.mixKeyAndHash(this.#psks.shift()!)
            break
          default:
            await this.#symmetric.mixKey(await this.#dhFor(token))
        }
      }
      parts.push(await this.#symmetric.encryptAndHash(payload))
      const message = concatBytes(...parts)
      if (message.length > MAX_MESSAGE_LEN) throw new NoiseError('noise: handshake message too long')
      await this.#advance()
      return message
    } catch (error) {
      this.#failed = true
      throw error
    }
  }

  async readMessage(message: Uint8Array): Promise<Uint8Array> {
    const tokens = this.#nextTokens(false)
    try {
      if (message.length > MAX_MESSAGE_LEN) throw new NoiseError('noise: handshake message too long')
      let offset = 0
      const take = (length: number): Uint8Array => {
        if (offset + length > message.length) throw new NoiseError('noise: handshake message truncated')
        const out = message.slice(offset, offset + length)
        offset += length
        return out
      }
      for (const token of tokens) {
        switch (token) {
          case 'e': {
            if (this.#re) throw new NoiseError('noise: remote ephemeral already set')
            this.#re = take(DHLEN)
            await this.#symmetric.mixHash(this.#re)
            if (this.#pskMode) await this.#symmetric.mixKey(this.#re)
            break
          }
          case 's': {
            if (this.#rs) throw new NoiseError('noise: remote static already set')
            const length = this.#symmetric.cipher.hasKey() ? DHLEN + 16 : DHLEN
            this.#rs = await this.#symmetric.decryptAndHash(take(length))
            break
          }
          case 'psk':
            await this.#symmetric.mixKeyAndHash(this.#psks.shift()!)
            break
          default:
            await this.#symmetric.mixKey(await this.#dhFor(token))
        }
      }
      const payload = await this.#symmetric.decryptAndHash(message.slice(offset))
      await this.#advance()
      return payload
    } catch (error) {
      this.#failed = true
      throw error
    }
  }

  #nextTokens(writing: boolean): readonly Token[] {
    if (this.#failed) throw new NoiseError('noise: handshake already failed')
    if (this.#index >= this.pattern.messages.length) throw new NoiseError('noise: handshake already complete')
    if (writing !== this.isMyTurn) throw new NoiseError(writing ? 'noise: not our turn to write' : 'noise: not our turn to read')
    return this.pattern.messages[this.#index]!
  }

  async #advance(): Promise<void> {
    this.#index += 1
    if (this.#index < this.pattern.messages.length) return
    const handshakeHash = this.#symmetric.handshakeHash
    const [c1, c2] = await this.#symmetric.split()
    this.#result = {
      send: this.initiator ? c1 : c2,
      receive: this.initiator ? c2 : c1,
      handshakeHash,
      remoteStatic: this.remoteStatic,
    }
  }

  async #mixPreMessage(tokens: readonly Token[], local: boolean): Promise<void> {
    for (const token of tokens) {
      if (token === 's') {
        const key = local ? this.#requireS().publicKey : this.#rs
        if (!key) throw new NoiseError('noise: pre-message needs the remote static key')
        await this.#symmetric.mixHash(key)
      } else if (token === 'e') {
        const key = local ? this.#e?.publicKey : this.#re
        if (!key) throw new NoiseError('noise: pre-message needs an ephemeral key')
        await this.#symmetric.mixHash(key)
      } else {
        throw new NoiseError(`noise: unexpected pre-message token ${token}`)
      }
    }
  }

  async #dhFor(token: Token): Promise<Uint8Array> {
    // es: initiator's e with responder's s; se: initiator's s with responder's e.
    let local: NoiseKeyPair | null
    let remote: Uint8Array | null
    switch (token) {
      case 'ee':
        ;[local, remote] = [this.#e, this.#re]
        break
      case 'ss':
        ;[local, remote] = [this.#s, this.#rs]
        break
      case 'es':
        ;[local, remote] = this.initiator ? [this.#e, this.#rs] : [this.#s, this.#re]
        break
      case 'se':
        ;[local, remote] = this.initiator ? [this.#s, this.#re] : [this.#e, this.#rs]
        break
      default:
        throw new NoiseError(`noise: not a DH token: ${token}`)
    }
    if (!local || !remote) throw new NoiseError(`noise: missing key for ${token}`)
    const shared = await local.dh(remote)
    // A low-order point yields an all-zero shared secret: all three platforms reject it the same way.
    if (shared.length !== DHLEN || isAllZero(shared)) throw new NoiseError('noise: invalid DH result')
    return shared
  }

  #requireS(): NoiseKeyPair {
    if (!this.#s) throw new NoiseError('noise: local static key required')
    return this.#s
  }
}
