// e2ee 1.0 的字节格式（contracts/e2ee/1.0/README.md，向量 vectors/aa-formats.json）：
// prologue、传输帧（flag + body）、分段密文、输入摘要、展示信封密封。原语来自 node:crypto。

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import type { ContentSealer } from '../application/ports/trust.js'
import { e2eeLabel } from '../domain/trust/index.js'
import { MAX_MESSAGE_LEN, TAGLEN } from './noise/crypto.js'

export const NOISE_PAIRING_PROTOCOL = 'Noise_XXpsk0_25519_AESGCM_SHA256'
export const NOISE_RECONNECT_PROTOCOL = 'Noise_KK_25519_AESGCM_SHA256'

export const FRAME_CONTINUE = 0x00
export const FRAME_FINAL = 0x01
export const FRAME_REKEY = 0x02
/** 65535 - 16 (tag) - 1 (flag). */
export const FRAME_MAX_BODY = MAX_MESSAGE_LEN - TAGLEN - 1
export const CHANNEL_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
export const REKEY_INTERVAL_FRAMES = 1 << 20
export const REKEY_INTERVAL_MS = 60 * 60 * 1000
export const SEALED_SEGMENT_BYTES = 64 * 1024
export const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function pairingPrologue(deviceId: string, pairingId: string, clientId: string, ch: string): Uint8Array {
  return e2eeLabel('pair', deviceId, pairingId, clientId, ch)
}

export function connectPrologue(deviceId: string, clientId: string, ch: string): Uint8Array {
  return e2eeLabel('connect', deviceId, clientId, ch)
}

export const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
export const fromB64url = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64url'))

/** Split one channel message into transport plaintexts: `flag ‖ body`, the last flagged FINAL. */
export function fragment(message: Uint8Array): Uint8Array[] {
  if (message.length > CHANNEL_MAX_MESSAGE_BYTES) throw new RangeError('channel message too large')
  const frames: Uint8Array[] = []
  let offset = 0
  do {
    const body = message.subarray(offset, offset + FRAME_MAX_BODY)
    offset += body.length
    const frame = new Uint8Array(body.length + 1)
    frame[0] = offset >= message.length ? FRAME_FINAL : FRAME_CONTINUE
    frame.set(body, 1)
    frames.push(frame)
  } while (offset < message.length)
  return frames
}

export type Reassembled = { readonly kind: 'message'; readonly bytes: Uint8Array } | { readonly kind: 'rekey' } | null

/** Collects fragments; returns a message when a FINAL frame completes one. */
export class Reassembler {
  #parts: Uint8Array[] = []
  #size = 0

  push(plaintext: Uint8Array): Reassembled {
    if (plaintext.length === 0) throw new RangeError('empty transport frame')
    const flag = plaintext[0]
    const body = plaintext.subarray(1)
    if (flag === FRAME_REKEY) {
      if (body.length !== 0 || this.#parts.length !== 0) throw new RangeError('rekey frame inside a message')
      return { kind: 'rekey' }
    }
    if (flag !== FRAME_CONTINUE && flag !== FRAME_FINAL) throw new RangeError(`unknown frame flag ${flag}`)
    this.#size += body.length
    if (this.#size > CHANNEL_MAX_MESSAGE_BYTES) throw new RangeError('channel message too large')
    this.#parts.push(body)
    if (flag === FRAME_CONTINUE) return null
    const bytes = Buffer.concat(this.#parts)
    this.#parts = []
    this.#size = 0
    return { kind: 'message', bytes: new Uint8Array(bytes) }
  }
}

function gcmEncrypt(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAGLEN })
  cipher.setAAD(ad)
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

function gcmDecrypt(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, sealed: Uint8Array): Buffer {
  if (sealed.length < TAGLEN) throw new RangeError('ciphertext shorter than tag')
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAGLEN })
  decipher.setAAD(ad)
  decipher.setAuthTag(sealed.subarray(sealed.length - TAGLEN))
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAGLEN)), decipher.final()])
}

/** Display envelopes: base64url(nonce12 ‖ AES-256-GCM(key, nonce, plaintext, ad)), random nonce per seal. */
export const nodeContentSealer: ContentSealer = {
  async seal(key, ad, plaintext) {
    const nonce = randomBytes(12)
    return b64url(Buffer.concat([nonce, gcmEncrypt(key, nonce, ad, plaintext)]))
  },
  async open(key, ad, sealed) {
    const bytes = fromB64url(sealed)
    if (bytes.length < 12 + TAGLEN) throw new RangeError('sealed payload too short')
    return new Uint8Array(gcmDecrypt(key, bytes.subarray(0, 12), ad, bytes.subarray(12)))
  },
}

/** Deterministic variant for vectors: seal with a given nonce. */
export function sealWithNonce(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): string {
  return b64url(Buffer.concat([nonce, gcmEncrypt(key, nonce, ad, plaintext)]))
}

export type SealedPurpose = 'attachment' | 'share'

function segmentNonce(index: number): Uint8Array {
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, BigInt(index), false)
  return nonce
}

export function sealedSegmentAd(purpose: SealedPurpose, objectId: string, index: number, final: boolean): Uint8Array {
  return Buffer.concat([e2eeLabel(purpose, objectId, String(index)), Uint8Array.of(0, final ? 1 : 0)])
}

/** Attachments and shares: 64 KiB segments, nonce = index, the final flag in the AD stops truncation. */
export function sealSegments(purpose: SealedPurpose, objectId: string, key: Uint8Array, plaintext: Uint8Array): Uint8Array[] {
  const count = Math.max(1, Math.ceil(plaintext.length / SEALED_SEGMENT_BYTES))
  const out: Uint8Array[] = []
  for (let index = 0; index < count; index++) {
    const chunk = plaintext.subarray(index * SEALED_SEGMENT_BYTES, (index + 1) * SEALED_SEGMENT_BYTES)
    const ad = sealedSegmentAd(purpose, objectId, index, index === count - 1)
    out.push(new Uint8Array(gcmEncrypt(key, segmentNonce(index), ad, chunk)))
  }
  return out
}

/** Inverse of {@link sealSegments}; throws on tampering, reordering or truncation. */
export function openSegments(purpose: SealedPurpose, objectId: string, key: Uint8Array, segments: readonly Uint8Array[]): Uint8Array {
  if (segments.length === 0) throw new RangeError('no segments')
  const parts = segments.map((segment, index) =>
    gcmDecrypt(key, segmentNonce(index), sealedSegmentAd(purpose, objectId, index, index === segments.length - 1), segment),
  )
  return new Uint8Array(Buffer.concat(parts))
}

export function inputDigest(directoryKey: Uint8Array, body: Uint8Array): string {
  const digestKey = createHmac('sha256', directoryKey).update(e2eeLabel('input-digest')).digest()
  return `hmac-sha256:${b64url(createHmac('sha256', digestKey).update(body).digest())}`
}
