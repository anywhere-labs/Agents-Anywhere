// e2ee 1.0 byte rules on the client (contracts/e2ee/1.0/README.md, vectors/aa-formats.json): ids, fingerprints,
// prologues, transport frames, display envelopes, sealed segments, input digests. Same rules as
// connector-ts/src/channel/formats.ts and server/agent_server/core/e2ee.py.

import { b64url, buf, fromB64url, fromUtf8, toHex, utf8 } from "./bytes"
import { MAX_MESSAGE_LEN, TAGLEN, concatBytes } from "./noise"
import { gcmDecrypt, gcmEncrypt, hmacSha256, randomBytes, sha256 } from "./webcrypto"

export const NOISE_PAIRING_PROTOCOL = "Noise_XXpsk0_25519_AESGCM_SHA256"
export const NOISE_RECONNECT_PROTOCOL = "Noise_KK_25519_AESGCM_SHA256"
export const PROLOGUE_LABEL = "aa-e2ee/1.0"

export const FRAME_CONTINUE = 0x00
export const FRAME_FINAL = 0x01
export const FRAME_REKEY = 0x02
/** 65535 - 16 (tag) - 1 (flag). */
export const FRAME_MAX_BODY = MAX_MESSAGE_LEN - TAGLEN - 1
export const CHANNEL_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
export const REKEY_INTERVAL_FRAMES = 1 << 20
export const REKEY_INTERVAL_MS = 60 * 60 * 1000
export const SEALED_SEGMENT_BYTES = 64 * 1024
export const CLIENT_ID_PATTERN = /^cli_[a-z2-7]{26}$/
export const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** `label(…)`: "aa-e2ee/1.0" and the fields joined with NUL, as UTF-8. */
export function e2eeLabel(...fields: string[]): Uint8Array {
  for (const field of fields) if (field.includes("\0")) throw new RangeError("binding fields must not contain NUL")
  return utf8([PROLOGUE_LABEL, ...fields].join("\0"))
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"

function base32Lower(bytes: Uint8Array): string {
  let out = ""
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** `cli_` + the first 26 lowercase base32 chars of SHA-256(label("client-id") ‖ 0x00 ‖ pub). */
export async function clientIdFor(identityPub: Uint8Array): Promise<string> {
  const digest = await sha256(concatBytes(e2eeLabel("client-id"), Uint8Array.of(0), identityPub))
  return `cli_${base32Lower(digest).slice(0, 26)}`
}

/** 8 groups of 4 hex digits of SHA-256(pub): what people compare out of band. */
export async function identityFingerprint(identityPub: Uint8Array): Promise<string> {
  const hex = toHex(await sha256(identityPub)).slice(0, 32)
  return hex.match(/.{4}/g)!.join(" ")
}

export function pairingPrologue(deviceId: string, pairingId: string, clientId: string, ch: string): Uint8Array {
  return e2eeLabel("pair", deviceId, pairingId, clientId, ch)
}

export function connectPrologue(deviceId: string, clientId: string, ch: string): Uint8Array {
  return e2eeLabel("connect", deviceId, clientId, ch)
}

/** Split one channel message into transport plaintexts: `flag ‖ body`, the last flagged FINAL. */
export function fragment(message: Uint8Array): Uint8Array[] {
  if (message.length > CHANNEL_MAX_MESSAGE_BYTES) throw new RangeError("channel message too large")
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

export type Reassembled = { readonly kind: "message"; readonly bytes: Uint8Array } | { readonly kind: "rekey" } | null

/** Collects fragments; returns a message when a FINAL frame completes one. */
export class Reassembler {
  #parts: Uint8Array[] = []
  #size = 0

  push(plaintext: Uint8Array): Reassembled {
    if (plaintext.length === 0) throw new RangeError("empty transport frame")
    const flag = plaintext[0]
    const body = plaintext.subarray(1)
    if (flag === FRAME_REKEY) {
      if (body.length !== 0 || this.#parts.length !== 0) throw new RangeError("rekey frame inside a message")
      return { kind: "rekey" }
    }
    if (flag !== FRAME_CONTINUE && flag !== FRAME_FINAL) throw new RangeError(`unknown frame flag ${flag}`)
    this.#size += body.length
    if (this.#size > CHANNEL_MAX_MESSAGE_BYTES) throw new RangeError("channel message too large")
    this.#parts.push(body)
    if (flag === FRAME_CONTINUE) return null
    const bytes = concatBytes(...this.#parts)
    this.#parts = []
    this.#size = 0
    return { kind: "message", bytes }
  }
}

export type DisplaySlot = "device" | "user"

/** AD of a sealed display envelope: binds it to its row so the Server cannot move a title between sessions. */
export function displayEnvelopeAd(deviceId: string, sessionId: string, slot: DisplaySlot, keyId: string): Uint8Array {
  return e2eeLabel("display", deviceId, sessionId, slot, keyId)
}

/** base64url(nonce12 ‖ AES-256-GCM(key, nonce, plaintext, ad)), random nonce. */
export async function sealDisplay(key: Uint8Array | CryptoKey, ad: Uint8Array, plaintext: Uint8Array, nonce = randomBytes(12)): Promise<string> {
  return b64url(concatBytes(nonce, await gcmEncrypt(key, nonce, ad, plaintext)))
}

export async function openDisplay(key: Uint8Array | CryptoKey, ad: Uint8Array, sealed: string): Promise<Uint8Array> {
  const bytes = fromB64url(sealed)
  if (bytes.length < 12 + TAGLEN) throw new RangeError("sealed payload too short")
  return gcmDecrypt(key, bytes.subarray(0, 12), ad, bytes.subarray(12))
}

/** Opens a `{mode: "sealed", keyId, payload}` display envelope into its JSON fields. */
export async function openDisplayEnvelope(
  key: Uint8Array | CryptoKey,
  target: { deviceId: string; sessionId: string; slot: DisplaySlot; keyId: string },
  payload: string,
): Promise<Record<string, unknown>> {
  const plaintext = await openDisplay(key, displayEnvelopeAd(target.deviceId, target.sessionId, target.slot, target.keyId), payload)
  return JSON.parse(fromUtf8(plaintext)) as Record<string, unknown>
}

export type SealedPurpose = "attachment" | "share"

function segmentNonce(index: number): Uint8Array {
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, BigInt(index), false)
  return nonce
}

export function sealedSegmentAd(purpose: SealedPurpose, objectId: string, index: number, final: boolean): Uint8Array {
  return concatBytes(e2eeLabel(purpose, objectId, String(index)), Uint8Array.of(0, final ? 1 : 0))
}

/** Attachments and shares: 64 KiB segments, nonce = index, the final flag in the AD stops truncation. */
export async function sealSegments(purpose: SealedPurpose, objectId: string, key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array[]> {
  const count = Math.max(1, Math.ceil(plaintext.length / SEALED_SEGMENT_BYTES))
  const aes = await globalThis.crypto.subtle.importKey("raw", buf(key), { name: "AES-GCM" }, false, ["encrypt"])
  const out: Uint8Array[] = []
  for (let index = 0; index < count; index++) {
    const chunk = plaintext.subarray(index * SEALED_SEGMENT_BYTES, (index + 1) * SEALED_SEGMENT_BYTES)
    out.push(await gcmEncrypt(aes, segmentNonce(index), sealedSegmentAd(purpose, objectId, index, index === count - 1), chunk))
  }
  return out
}

/** Inverse of {@link sealSegments}; throws on tampering, reordering or truncation. */
export async function openSegments(purpose: SealedPurpose, objectId: string, key: Uint8Array, segments: readonly Uint8Array[]): Promise<Uint8Array> {
  if (segments.length === 0) throw new RangeError("no segments")
  const aes = await globalThis.crypto.subtle.importKey("raw", buf(key), { name: "AES-GCM" }, false, ["decrypt"])
  const parts: Uint8Array[] = []
  for (const [index, segment] of segments.entries())
    parts.push(await gcmDecrypt(aes, segmentNonce(index), sealedSegmentAd(purpose, objectId, index, index === segments.length - 1), segment))
  return concatBytes(...parts)
}

/** The sub-key for input digests: HMAC(directoryKey, label("input-digest")). */
export async function inputDigestKey(directoryKey: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(directoryKey, e2eeLabel("input-digest"))
}

/** `hmac-sha256:` + base64url(HMAC(inputDigestKey, body)) over the exact request body bytes. */
export async function inputDigest(directoryKey: Uint8Array | { digestKey: Uint8Array | CryptoKey }, body: Uint8Array): Promise<string> {
  const key = directoryKey instanceof Uint8Array ? await inputDigestKey(directoryKey) : directoryKey.digestKey
  return `hmac-sha256:${b64url(await hmacSha256(key, body))}`
}

export { b64url, fromB64url }
