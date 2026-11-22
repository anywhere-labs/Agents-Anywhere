// Out-of-band encrypted device pairing parser & Web grey-lock trust policy
// Strictly aligned with contracts/aa-v3/1.0/pairing.schema.json & docs/v3/e2ee-admission-proposal.md

import type {
  ClientDeviceTrustRecord,
  LockBadge,
  PairingErrorCode,
  PairingPayload,
  TrustTier,
} from "@/lib/types/v3"
import { clientTrustTier } from "@/lib/platform/desktop"

const PAIR_URI_PREFIX = "aa-pair://v1/"
const BASE64URL_32_RE = /^[A-Za-z0-9_-]{43}$/

export class PairingError extends Error {
  readonly code: PairingErrorCode

  constructor(code: PairingErrorCode, message: string) {
    super(message)
    this.name = "PairingError"
    this.code = code
  }
}

function decodeBase64UrlUtf8(encoded: string): string {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/")
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(normalized + padding)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function decodeBase64UrlBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/")
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(normalized + padding)
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function encodePairingUri(payload: PairingPayload): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  const b64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${PAIR_URI_PREFIX}${b64url}`
}

/**
 * Parse and strictly validate an out-of-band `aa-pair://v1/<base64url>` URI.
 * Never accepts server hints; rejects malformed, wrong-version, or expired payloads.
 */
export function parsePairingUri(rawUri: string, nowMs: number = Date.now()): PairingPayload {
  const trimmed = rawUri.trim()
  if (!trimmed.startsWith(PAIR_URI_PREFIX)) {
    throw new PairingError(
      "invalid_pairing_uri",
      "Pairing URI must start with aa-pair://v1/"
    )
  }
  const encoded = trimmed.slice(PAIR_URI_PREFIX.length)
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new PairingError("invalid_pairing_uri", "Pairing URI payload is not valid base64url")
  }

  let raw: unknown
  try {
    raw = JSON.parse(decodeBase64UrlUtf8(encoded))
  } catch {
    throw new PairingError("invalid_pairing_uri", "Pairing URI JSON could not be decoded")
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PairingError("invalid_pairing_uri", "Pairing payload must be a JSON object")
  }

  const obj = raw as Record<string, unknown>
  const allowedKeys = new Set(["v", "instance_id", "device_pub", "pairing_id", "psk", "expires_at"])
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new PairingError("invalid_pairing_uri", `Unexpected field "${key}" in pairing payload`)
    }
  }

  if (obj.v !== 1) {
    throw new PairingError("invalid_pairing_uri", "Unsupported pairing payload version")
  }
  if (
    typeof obj.instance_id !== "string" ||
    obj.instance_id.length < 1 ||
    obj.instance_id.length > 128
  ) {
    throw new PairingError("invalid_pairing_uri", "Invalid instance_id in pairing payload")
  }
  if (typeof obj.device_pub !== "string" || !BASE64URL_32_RE.test(obj.device_pub)) {
    throw new PairingError("invalid_pairing_uri", "Invalid X25519 device_pub in pairing payload")
  }
  if (
    typeof obj.pairing_id !== "string" ||
    obj.pairing_id.length < 8 ||
    obj.pairing_id.length > 128
  ) {
    throw new PairingError("invalid_pairing_uri", "Invalid pairing_id in pairing payload")
  }
  if (typeof obj.psk !== "string" || !BASE64URL_32_RE.test(obj.psk)) {
    throw new PairingError("invalid_pairing_uri", "Invalid 32-byte PSK in pairing payload")
  }
  if (typeof obj.expires_at !== "string") {
    throw new PairingError("invalid_pairing_uri", "Missing expires_at in pairing payload")
  }

  const expiresMs = Date.parse(obj.expires_at)
  if (!Number.isFinite(expiresMs)) {
    throw new PairingError("invalid_pairing_uri", "Invalid expires_at timestamp")
  }
  if (expiresMs <= nowMs) {
    throw new PairingError("pairing_expired", "Pairing link has expired; generate a new one on the work device")
  }

  return {
    v: 1,
    instance_id: obj.instance_id,
    device_pub: obj.device_pub,
    pairing_id: obj.pairing_id,
    psk: obj.psk,
    expires_at: obj.expires_at,
  }
}

/**
 * Derive a human-verifiable SHA-256 hex fingerprint (grouped 4-char blocks)
 * from a 32-byte base64url X25519 public key.
 */
export async function formatKeyFingerprint(publicKeyB64Url: string): Promise<string> {
  const bytes = decodeBase64UrlBytes(publicKeyB64Url)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  const hex = Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0").toUpperCase()
  ).join("")
  return hex.match(/.{1,4}/g)?.join(" ") ?? hex
}

export function trustTierToBadge(tier: TrustTier): LockBadge {
  return tier === "verified_app" ? "green" : "grey"
}

export function buildWebTrustRecord(
  payload: PairingPayload,
  deviceNameHint?: string
): ClientDeviceTrustRecord {
  return {
    device_id: payload.instance_id,
    device_pub: payload.device_pub,
    require_e2ee: true,
    trust_tier: clientTrustTier(),
    paired_at: new Date().toISOString(),
    ...(deviceNameHint ? { device_name_hint: deviceNameHint } : {}),
  }
}
