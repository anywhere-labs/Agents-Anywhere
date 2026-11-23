// Arbitrary-password multi-device E2EE for Portable Assistant conversations & Cloud VFS.
// Follows docs/v3/assistant-and-files-proposal.md §5 & §6.4:
//   - Allows ANY user password (no artificial length/complexity block; gentle advisory hint only).
//   - PBKDF2-SHA256 derives a 256-bit KEK from (password, salt, iterations).
//   - AES-256-GCM wraps a random 256-bit DEK -> `{kdf, kdf_params, salt, wrap_alg, wrap_nonce, wrapped_dek}`.
//   - Whole conversations (`{title, settings, messages}`) are encrypted with DEK + fresh 96-bit nonce
//     + AAD `utf8("${userId}:${conversationId}")` to prevent server swap attacks.

import type { AssistantKeyEnvelopeView } from "@/lib/types/v3"

export const DEFAULT_PBKDF2_ITERATIONS = 600_000

export type PassphraseStrength = "short" | "fair" | "strong"

export function assessPassphraseStrength(password: string): PassphraseStrength {
  if (password.length < 6) return "short"
  const classes =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/[0-9]/.test(password)) +
    Number(/[^a-zA-Z0-9]/.test(password))
  if (password.length >= 12 && classes >= 3) return "strong"
  if (password.length >= 16) return "strong"
  return "fair"
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64UrlToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/")
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(normalized + padding)
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function generateDek(): Uint8Array<ArrayBuffer> {
  const dek = new Uint8Array(new ArrayBuffer(32))
  crypto.getRandomValues(dek)
  return dek
}

function randomNonce(): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(new ArrayBuffer(12))
  crypto.getRandomValues(nonce)
  return nonce
}

function randomSalt(): Uint8Array<ArrayBuffer> {
  const salt = new Uint8Array(new ArrayBuffer(16))
  crypto.getRandomValues(salt)
  return salt
}

async function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

async function deriveKekPbkdf2(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  )
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

export interface WrappedEnvelopePayload {
  kdf: "pbkdf2-sha256"
  kdf_params: { iterations: number; hash: "SHA-256" }
  salt: string
  wrap_alg: "AES-256-GCM"
  wrap_nonce: string
  wrapped_dek: string
}

/**
 * Wrap a 256-bit DEK with any user-chosen password (empty passwords are rejected only to prevent accidental blank clicks).
 */
export async function wrapDekWithPassword(
  password: string,
  dek: Uint8Array<ArrayBuffer>,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<WrappedEnvelopePayload> {
  if (!password) {
    throw new Error("Password cannot be empty")
  }
  const salt = randomSalt()
  const nonce = randomNonce()
  const kek = await deriveKekPbkdf2(password, salt, iterations)
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, kek, dek)
  )
  return {
    kdf: "pbkdf2-sha256",
    kdf_params: { iterations, hash: "SHA-256" },
    salt: bytesToBase64Url(salt),
    wrap_alg: "AES-256-GCM",
    wrap_nonce: bytesToBase64Url(nonce),
    wrapped_dek: bytesToBase64Url(wrapped),
  }
}

/**
 * Unwrap the account DEK from a cloud envelope using the user's password.
 * Throws if the password is wrong (AES-GCM tag verification fails).
 */
export async function unwrapDekWithPassword(
  password: string,
  envelope: Pick<
    AssistantKeyEnvelopeView,
    "kdf" | "kdf_params" | "salt" | "wrap_nonce" | "wrapped_dek"
  >
): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope.kdf !== "pbkdf2-sha256") {
    throw new Error(`Unsupported KDF in browser: ${envelope.kdf}`)
  }
  const iterations = Number(envelope.kdf_params.iterations)
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("Invalid PBKDF2 iterations in key envelope")
  }
  const salt = base64UrlToBytes(envelope.salt)
  const kek = await deriveKekPbkdf2(password, salt, iterations)

  let nonce: Uint8Array<ArrayBuffer>
  let ciphertext: Uint8Array<ArrayBuffer>
  if (envelope.wrap_nonce) {
    nonce = base64UrlToBytes(envelope.wrap_nonce)
    ciphertext = base64UrlToBytes(envelope.wrapped_dek)
  } else {
    const packed = base64UrlToBytes(envelope.wrapped_dek)
    nonce = packed.slice(0, 12)
    ciphertext = packed.slice(12)
  }

  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, kek, ciphertext)
  const dek = new Uint8Array(new ArrayBuffer(plainBuf.byteLength))
  dek.set(new Uint8Array(plainBuf))
  if (dek.byteLength !== 32) {
    throw new Error("Unwrapped DEK has unexpected length")
  }
  return dek
}

export interface ConversationPlainPayload {
  title: string
  settings: Record<string, unknown> | null
  messages: Record<string, unknown>[]
}

export interface EncryptedConversationBundle {
  nonce: string
  ciphertext: string
  meta_nonce: string
  encrypted_meta: string
}

function conversationAad(userId: string, conversationId: string): Uint8Array<ArrayBuffer> {
  const raw = new TextEncoder().encode(`${userId}:${conversationId}`)
  const out = new Uint8Array(new ArrayBuffer(raw.byteLength))
  out.set(raw)
  return out
}

export async function encryptConversation(
  dek: Uint8Array<ArrayBuffer>,
  userId: string,
  conversationId: string,
  payload: ConversationPlainPayload
): Promise<EncryptedConversationBundle> {
  const key = await importAesKey(dek)
  const aad = conversationAad(userId, conversationId)

  const nonce = randomNonce()
  const bodyPlain = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, bodyPlain)
  )

  const metaNonce = randomNonce()
  const metaPlain = new TextEncoder().encode(JSON.stringify({ title: payload.title }))
  const encryptedMeta = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: metaNonce, additionalData: aad },
      key,
      metaPlain
    )
  )

  return {
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(ciphertext),
    meta_nonce: bytesToBase64Url(metaNonce),
    encrypted_meta: bytesToBase64Url(encryptedMeta),
  }
}

export async function decryptConversation(
  dek: Uint8Array<ArrayBuffer>,
  userId: string,
  conversationId: string,
  nonceB64: string,
  ciphertextB64: string
): Promise<ConversationPlainPayload> {
  const key = await importAesKey(dek)
  const aad = conversationAad(userId, conversationId)
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(nonceB64), additionalData: aad },
    key,
    base64UrlToBytes(ciphertextB64)
  )
  return JSON.parse(new TextDecoder().decode(plainBuf)) as ConversationPlainPayload
}

export async function decryptConversationMeta(
  dek: Uint8Array<ArrayBuffer>,
  userId: string,
  conversationId: string,
  metaNonceB64: string,
  encryptedMetaB64: string
): Promise<{ title: string }> {
  const key = await importAesKey(dek)
  const aad = conversationAad(userId, conversationId)
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(metaNonceB64), additionalData: aad },
    key,
    base64UrlToBytes(encryptedMetaB64)
  )
  return JSON.parse(new TextDecoder().decode(plainBuf)) as { title: string }
}

// ---------------------------------------------------------------------------
// Cloud Drive VFS file encryption (`account_dek`)
// ---------------------------------------------------------------------------

function vfsAad(userId: string, vfsPath: string): Uint8Array<ArrayBuffer> {
  const raw = new TextEncoder().encode(`${userId}:vfs:${vfsPath}`)
  const out = new Uint8Array(new ArrayBuffer(raw.byteLength))
  out.set(raw)
  return out
}

export async function encryptVfsFile(
  dek: Uint8Array<ArrayBuffer>,
  userId: string,
  vfsPath: string,
  plaintext: Uint8Array<ArrayBuffer>,
  filename: string
): Promise<{
  ciphertext: Uint8Array<ArrayBuffer>
  nonce: string
  encryptedMeta: string
}> {
  const key = await importAesKey(dek)
  const aad = vfsAad(userId, vfsPath)
  const nonce = randomNonce()
  const encBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    plaintext
  )
  const ciphertext = new Uint8Array(new ArrayBuffer(encBuf.byteLength))
  ciphertext.set(new Uint8Array(encBuf))

  const metaNonce = randomNonce()
  const metaEnc = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: metaNonce, additionalData: aad },
      key,
      new TextEncoder().encode(JSON.stringify({ filename, path: vfsPath }))
    )
  )
  const packedMeta = new Uint8Array(new ArrayBuffer(12 + metaEnc.byteLength))
  packedMeta.set(metaNonce, 0)
  packedMeta.set(metaEnc, 12)

  return {
    ciphertext,
    nonce: bytesToBase64Url(nonce),
    encryptedMeta: bytesToBase64Url(packedMeta),
  }
}

export async function decryptVfsFile(
  dek: Uint8Array<ArrayBuffer>,
  userId: string,
  vfsPath: string,
  nonceB64: string,
  ciphertext: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await importAesKey(dek)
  const aad = vfsAad(userId, vfsPath)
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(nonceB64), additionalData: aad },
    key,
    ciphertext
  )
  const out = new Uint8Array(new ArrayBuffer(plainBuf.byteLength))
  out.set(new Uint8Array(plainBuf))
  return out
}

// ---------------------------------------------------------------------------
// SHA-256 content hashes
// ---------------------------------------------------------------------------

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

export async function computeConversationHash(
  title: string,
  messages: Record<string, unknown>[],
  settings: Record<string, unknown> | null
): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify({ title, messages, settings }))
  const buf = new Uint8Array(new ArrayBuffer(raw.byteLength))
  buf.set(raw)
  const full = await sha256Hex(buf)
  return full.slice(0, 32)
}
