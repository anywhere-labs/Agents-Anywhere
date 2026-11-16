// Encrypted attachments (contracts/e2ee/1.0 「加密的存放内容」): the client seals a file with a random key before
// uploading it over plain HTTPS (`x-aa-sealed: segments-v1`, named `attachment.bin`, `application/octet-stream`);
// the key, the real name and the real type reach the device only inside the secure channel, as
// `sealedAttachmentKeys` next to the `attachments` of the request that uses the file. Keys stay in memory and are
// never written to disk: after a restart a file is sealed and uploaded again.

import type { SealedAttachmentKey } from "@/generated/e2ee/v1_0/sealed-attachment-key"
import { b64url, fromB64url, toHex } from "./bytes"
import { SEALED_SEGMENT_BYTES, openSegments, sealSegments } from "./formats"
import { TAGLEN, concatBytes } from "./noise"
import { randomBytes, sha256 } from "./webcrypto"

export type { SealedAttachmentKey }
export { SEALED_UPLOAD_HEADER, SEALED_UPLOAD_VALUE } from "@/lib/transport/content-transport"

/** What the Server sees of every sealed upload: the real name and type travel in the channel. */
export const SEALED_UPLOAD_NAME = "attachment.bin"
export const SEALED_UPLOAD_TYPE = "application/octet-stream"

export interface SealedAttachment {
  /** Upload body: the segment ciphertexts concatenated in order. */
  readonly body: Uint8Array
  readonly key: Uint8Array
  /** Lowercase hex SHA-256 of the plaintext; also the segment AD objectId. */
  readonly sha256: string
  readonly size: number
}

export async function sealAttachment(plaintext: Uint8Array): Promise<SealedAttachment> {
  const key = randomBytes(32)
  const digest = toHex(await sha256(plaintext))
  const segments = await sealSegments("attachment", digest, key, plaintext)
  return { body: concatBytes(...segments), key, sha256: digest, size: plaintext.length }
}

/** What the device does: split the upload body into segments, open them, check size and SHA-256. */
export async function openSealedAttachment(key: SealedAttachmentKey, body: Uint8Array): Promise<Uint8Array> {
  const stride = SEALED_SEGMENT_BYTES + TAGLEN
  const segments: Uint8Array[] = []
  for (let offset = 0; offset < body.length || segments.length === 0; offset += stride) segments.push(body.subarray(offset, offset + stride))
  const plaintext = await openSegments("attachment", key.sha256, fromB64url(key.key), segments)
  if (plaintext.length !== key.size || toHex(await sha256(plaintext)) !== key.sha256) throw new RangeError("attachment does not match its key")
  return plaintext
}

/** In-memory keys of this client's sealed uploads, by `fileId`. */
export class AttachmentKeyRing {
  readonly #keys = new Map<string, SealedAttachmentKey>()

  remember(
    fileId: string,
    sealed: Pick<SealedAttachment, "key" | "size" | "sha256">,
    file: { name?: string | null; mimeType?: string | null } = {},
  ): SealedAttachmentKey {
    const entry: SealedAttachmentKey = { fileId, key: b64url(sealed.key), size: sealed.size, sha256: sealed.sha256 }
    if (file.name) entry.name = file.name
    if (file.mimeType) entry.mimeType = file.mimeType
    this.#keys.set(fileId, entry)
    return entry
  }

  get(fileId: string): SealedAttachmentKey | undefined {
    return this.#keys.get(fileId)
  }

  /** `body` plus `sealedAttachmentKeys` for every attachment it references that this client sealed. */
  attach<T extends Record<string, unknown>>(body: T): T {
    const refs = body["attachments"]
    if (!Array.isArray(refs)) return body
    const keys: SealedAttachmentKey[] = []
    for (const ref of refs) {
      const fileId = ref && typeof ref === "object" ? (ref as { fileId?: unknown }).fileId : undefined
      const key = typeof fileId === "string" ? this.#keys.get(fileId) : undefined
      if (key && !keys.includes(key)) keys.push(key)
    }
    return keys.length ? { ...body, sealedAttachmentKeys: keys } : body
  }

  clear(): void {
    this.#keys.clear()
  }
}
