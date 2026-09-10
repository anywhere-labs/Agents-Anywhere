import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller'
import type { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { readJson, writeJson } from '../storage/files.js'
import { canonicalJson, digest } from './identity.js'
import { BridgeError } from './errors.js'
import { record } from './types.js'

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export interface AttachmentReference {
  fileId: string
  name: string
  mediaType: string
  size: number
  sha256: string
}
export interface StagedAttachment extends AttachmentReference { uploadId: string }
export interface AttachmentReceipt {
  platformId: string
  fingerprint: string
  attachments: AttachmentReference[]
}
export interface AttachmentSnapshot extends SessionLogSnapshot { bridgeRevision?: string, attachmentReceipts?: Record<string, AttachmentReceipt> }

/** The Bridge accepts opaque staging IDs, never caller-selected filesystem paths. */
export function parseAttachments(value: unknown): StagedAttachment[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new BridgeError('INVALID_PARAMS', 'Attachments must be an array.')
  const files = new Set<string>(), uploads = new Set<string>()
  return value.map(raw => {
    const item = record(raw)
    if (typeof item.mediaType !== 'string' || !/^[-\w.+]+\/[-\w.+]+$/.test(item.mediaType)) {
      throw new BridgeError('INVALID_PARAMS', 'Invalid attachment media type.')
    }
    if (typeof item.fileId !== 'string' || !/^file_[\w-]{1,128}$/.test(item.fileId) ||
        typeof item.uploadId !== 'string' || !/^[a-f0-9]{32}$/.test(item.uploadId) ||
        typeof item.name !== 'string' || !item.name || item.name.length > 1024 ||
        typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 ||
        typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        files.has(item.fileId) || uploads.has(item.uploadId)) {
      throw new BridgeError('INVALID_PARAMS', 'Invalid or duplicate attachment.')
    }
    files.add(item.fileId); uploads.add(item.uploadId)
    return { fileId: item.fileId, uploadId: item.uploadId, name: item.name,
      mediaType: item.mediaType as ImageMediaType, size: item.size, sha256: item.sha256 }
  })
}

export function attachmentReferences(images: readonly StagedAttachment[]): AttachmentReference[] {
  return images.map(({ uploadId: _, ...reference }) => reference)
}

export function attachmentFingerprint(text: string, images: readonly StagedAttachment[]): string {
  return digest(canonicalJson({ text, attachments: attachmentReferences(images).map(image => ({ ...image })) }))
}

export function receiptKey(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message') return
  const source = record(event.data.source)
  return typeof source.rpcId === 'string' ? source.rpcId : event.data.id
}

/** AA file references survive Host restarts; DSH owns the actual attachment objects. */
export class RuntimeAttachments {
  readonly staging: string
  constructor(private readonly root: string) { this.staging = join(root, 'staging') }

  async initialize(): Promise<void> { await mkdir(this.staging, { recursive: true, mode: 0o700 }) }

  async readReceipts(id: string): Promise<Record<string, AttachmentReceipt>> {
    return await readJson<Record<string, AttachmentReceipt>>(join(this.root, 'receipts', `${digest(id)}.json`)) ?? {}
  }

  /** Called under NativeRuntime's per-session write queue, before official prompt admission. */
  async remember(id: string, requestId: string, receipt: AttachmentReceipt): Promise<void> {
    const receipts = await this.readReceipts(id)
    receipts[requestId] = receipt
    await writeJson(join(this.root, 'receipts', `${digest(id)}.json`), receipts)
  }

  async prepare(images: readonly StagedAttachment[], store: AttachmentStore, signal: AbortSignal,
    upload?: { service: FileUploads, sessionId: SessionId }): Promise<PromptContentPart[]> {
    const imageFiles = images.filter(image => IMAGE_MIME_TYPES.includes(image.mediaType as ImageMediaType))
    if (imageFiles.length !== images.length && !upload) throw new BridgeError(
      'UNSUPPORTED_OPERATION', 'File attachments require DSH 0.1.5-rc.1 or later. Update DSH and restart the plugin.')
    const limits = store.imageLimits
    if (imageFiles.length > limits.maxImagesPerMessage || imageFiles.some(image => image.size > limits.maxImageBytes) ||
        imageFiles.reduce((total, image) => total + image.size, 0) > limits.maxMessageImageBytes) {
      throw new BridgeError('INVALID_PARAMS', 'Images exceed the DSH attachment size or count limits.')
    }
    const root = await realpath(this.staging)
    const parts: PromptContentPart[] = []
    for (const image of images) {
      signal.throwIfAborted()
      const path = join(root, image.uploadId)
      if ((await lstat(path)).isSymbolicLink()) throw new BridgeError('INVALID_PARAMS', 'Attachment staging cannot use symbolic links.')
      // Resolve the parent as well as refusing a symlink at the file itself.
      if (dirname(await realpath(path)) !== root) throw new BridgeError('INVALID_PARAMS', 'Invalid attachment staging location.')
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== image.size) throw new BridgeError('INVALID_PARAMS', 'Staged attachment size does not match its upload.')
        if (IMAGE_MIME_TYPES.includes(image.mediaType as ImageMediaType)) {
          const data = await file.readFile()
          if (data.length !== image.size || createHash('sha256').update(data).digest('hex') !== image.sha256) {
            throw new BridgeError('INVALID_PARAMS', 'Staged attachment content does not match its upload.')
          }
          parts.push({ type: 'image', name: image.name, mediaType: image.mediaType as ImageMediaType, data: data.toString('base64') })
        } else {
          // Validate while streaming. Throw before EOF so DSH cannot commit a corrupt upload.
          const data = async function* () {
            const hash = createHash('sha256')
            let bytes = 0
            for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
              signal.throwIfAborted()
              bytes += chunk.length
              if (bytes > image.size) throw new BridgeError('INVALID_PARAMS', 'Staged attachment size does not match its upload.')
              hash.update(chunk)
              yield chunk as Buffer
            }
            signal.throwIfAborted()
            if (bytes !== image.size || hash.digest('hex') !== image.sha256) {
              throw new BridgeError('INVALID_PARAMS', 'Staged attachment content does not match its upload.')
            }
          }
          const result = await upload!.service.uploadStream({ sessionId: upload!.sessionId, name: image.name, data: data(), signal })
          parts.push({ type: 'file', receiptId: result.receiptId })
        }
      } finally { await file.close() }
    }
    signal.throwIfAborted()
    // SessionController.prompt performs official batch admission and saveImages before enqueueing.
    return parts
  }
}
