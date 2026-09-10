import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AttachmentStore, ImageMediaType, PromptContentPart } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { readJson, writeJson } from '../storage/files.js'
import { canonicalJson, digest } from './identity.js'
import { BridgeError } from './errors.js'
import { record } from './types.js'

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export interface ImageReference {
  fileId: string
  name: string
  mediaType: ImageMediaType
  size: number
  sha256: string
}
export interface StagedImage extends ImageReference { uploadId: string }
export interface ImageReceipt {
  platformId: string
  fingerprint: string
  attachments: ImageReference[]
}
export interface AttachmentSnapshot extends SessionLogSnapshot { bridgeRevision?: string, attachmentReceipts?: Record<string, ImageReceipt> }

/** The Bridge accepts opaque staging IDs, never caller-selected filesystem paths. */
export function parseImages(value: unknown): StagedImage[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new BridgeError('INVALID_PARAMS', 'Attachments must be an array.')
  const files = new Set<string>(), uploads = new Set<string>()
  return value.map(raw => {
    const item = record(raw)
    if (typeof item.mediaType !== 'string' || !IMAGE_MIME_TYPES.includes(item.mediaType as ImageMediaType)) {
      throw new BridgeError('INVALID_PARAMS', 'DSH only accepts PNG, JPEG, WebP and GIF images.')
    }
    if (typeof item.fileId !== 'string' || !/^file_[\w-]{1,128}$/.test(item.fileId) ||
        typeof item.uploadId !== 'string' || !/^[a-f0-9]{32}$/.test(item.uploadId) ||
        typeof item.name !== 'string' || !item.name || item.name.length > 1024 ||
        typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size <= 0 ||
        typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        files.has(item.fileId) || uploads.has(item.uploadId)) {
      throw new BridgeError('INVALID_PARAMS', 'Invalid or duplicate image attachment.')
    }
    files.add(item.fileId); uploads.add(item.uploadId)
    return { fileId: item.fileId, uploadId: item.uploadId, name: item.name,
      mediaType: item.mediaType as ImageMediaType, size: item.size, sha256: item.sha256 }
  })
}

export function imageReferences(images: readonly StagedImage[]): ImageReference[] {
  return images.map(({ uploadId: _, ...reference }) => reference)
}

export function imageFingerprint(text: string, images: readonly StagedImage[]): string {
  return digest(canonicalJson({ text, attachments: imageReferences(images).map(image => ({ ...image })) }))
}

export function receiptKey(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message') return
  const source = record(event.data.source)
  return typeof source.rpcId === 'string' ? source.rpcId : event.data.id
}

/** AA file references survive Host restarts; DSH owns the actual normalized image objects. */
export class RuntimeImages {
  readonly staging: string
  constructor(private readonly root: string) { this.staging = join(root, 'staging') }

  async initialize(): Promise<void> { await mkdir(this.staging, { recursive: true, mode: 0o700 }) }

  async readReceipts(id: string): Promise<Record<string, ImageReceipt>> {
    return await readJson<Record<string, ImageReceipt>>(join(this.root, 'receipts', `${digest(id)}.json`)) ?? {}
  }

  /** Called under NativeRuntime's per-session write queue, before official prompt admission. */
  async remember(id: string, requestId: string, receipt: ImageReceipt): Promise<void> {
    const receipts = await this.readReceipts(id)
    receipts[requestId] = receipt
    await writeJson(join(this.root, 'receipts', `${digest(id)}.json`), receipts)
  }

  async prepare(images: readonly StagedImage[], store: AttachmentStore, signal: AbortSignal): Promise<PromptContentPart[]> {
    const limits = store.imageLimits
    if (images.length > limits.maxImagesPerMessage || images.some(image => image.size > limits.maxImageBytes) ||
        images.reduce((total, image) => total + image.size, 0) > limits.maxMessageImageBytes) {
      throw new BridgeError('INVALID_PARAMS', 'Images exceed the DSH attachment size or count limits.')
    }
    const root = await realpath(this.staging)
    const parts: PromptContentPart[] = []
    for (const image of images) {
      signal.throwIfAborted()
      const path = join(root, image.uploadId)
      if ((await lstat(path)).isSymbolicLink()) throw new BridgeError('INVALID_PARAMS', 'Image staging cannot use symbolic links.')
      // Resolve the parent as well as refusing a symlink at the file itself.
      if (dirname(await realpath(path)) !== root) throw new BridgeError('INVALID_PARAMS', 'Invalid image staging location.')
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== image.size) throw new BridgeError('INVALID_PARAMS', 'Staged image size does not match its upload.')
        const data = await file.readFile()
        if (data.length !== image.size || createHash('sha256').update(data).digest('hex') !== image.sha256) {
          throw new BridgeError('INVALID_PARAMS', 'Staged image content does not match its upload.')
        }
        parts.push({ type: 'image', name: image.name, mediaType: image.mediaType, data: data.toString('base64') })
      } finally { await file.close() }
    }
    signal.throwIfAborted()
    // SessionController.prompt performs official batch admission and saveImages before enqueueing.
    return parts
  }
}
