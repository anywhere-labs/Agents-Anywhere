// Prompt attachments on this device: a Server file id is downloaded once into the data directory and handed to the
// Runtime as a local path (04-connector.md §5: Codex and others take a path, so no data URL bloats native history).
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { WorkspaceError } from './errors.js'

export interface AttachmentSource {
  readonly fileId: string
  readonly name: string
  readonly mediaType: string
  /** Plaintext size; for a sealed upload the Server holds `size + 16 per 64 KiB segment` bytes. */
  readonly size: number
  /** Plaintext SHA-256 (hex, optionally `sha256:`-prefixed). Required for a sealed upload (its segment AD). */
  readonly sha256?: string | null
  /** E2EE: the segment key (base64url, 32 bytes); the Server only holds the ciphertext. */
  readonly sealedKey?: string | null
}

/** Opens a sealed upload: the concatenated segments, the key and the plaintext SHA-256 (segment AD object id). */
export type OpenSealed = (ciphertext: Buffer, key: string, sha256: string) => Buffer

export interface LocalAttachment {
  readonly path: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
}

/** Fetches the bytes of a Server file (the link layer supplies it: HTTPS with the device token and egress). */
export type FetchFile = (fileId: string, sessionId: string, signal?: AbortSignal) => Promise<AsyncIterable<Uint8Array>>

/** A file name that is safe on every platform, keeping the extension the Runtime uses to guess the type. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').replace(/^\.+/u, '_').trim().slice(-120)
  return cleaned === '' ? 'attachment' : cleaned
}

export class AttachmentCache {
  private readonly inFlight = new Map<string, Promise<LocalAttachment>>()

  public constructor(
    private readonly dir: string,
    private readonly fetchFile: FetchFile,
    /** E2EE: how sealed uploads are opened (contracts/e2ee/1.0 segments); without it they are refused. */
    private readonly openSealed?: OpenSealed,
  ) {}

  private pathOf(sessionId: string, source: AttachmentSource): string {
    const sessionDir = createHash('sha256').update(sessionId).digest('hex').slice(0, 24)
    return join(this.dir, sessionDir, safeFileName(source.fileId), safeFileName(source.name))
  }

  /** The local copy of an attachment, downloading it on first use; concurrent callers share one download. */
  public async resolve(sessionId: string, source: AttachmentSource, signal?: AbortSignal): Promise<LocalAttachment> {
    const path = this.pathOf(sessionId, source)
    const existing = await stat(path).catch(() => undefined)
    if (existing?.isFile() === true && existing.size === source.size) return { path, name: source.name, mediaType: source.mediaType, size: existing.size }
    let running = this.inFlight.get(path)
    if (running === undefined) {
      running = (source.sealedKey != null ? this.downloadSealed(sessionId, path, source, signal) : this.download(sessionId, path, source, signal)).finally(() => this.inFlight.delete(path))
      this.inFlight.set(path, running)
    }
    return running
  }

  private async download(sessionId: string, path: string, source: AttachmentSource, signal?: AbortSignal): Promise<LocalAttachment> {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.part-${randomBytes(4).toString('hex')}`
    const hash = createHash('sha256')
    let size = 0
    try {
      const body = await this.fetchFile(source.fileId, sessionId, signal)
      await pipeline(
        async function* count() {
          for await (const chunk of body) {
            hash.update(chunk)
            size += chunk.length
            yield chunk
          }
        },
        createWriteStream(tmp, { flags: 'wx' }),
        ...(signal === undefined ? [] : [{ signal }]),
      )
      if (size !== source.size) throw new WorkspaceError('attachment_corrupt', `attachment ${source.fileId}: got ${size} bytes, expected ${source.size}`)
      const digest = hash.digest('hex')
      const expected = source.sha256?.replace(/^sha256:/u, '')
      if (expected !== undefined && expected !== null && expected !== '' && expected !== digest) {
        throw new WorkspaceError('attachment_corrupt', `attachment ${source.fileId}: sha256 mismatch`)
      }
      await rename(tmp, path)
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
    return { path, name: source.name, mediaType: source.mediaType, size }
  }

  /**
   * A sealed upload (E2EE): the ciphertext is fetched whole (the Runtime needs the plaintext file anyway), opened
   * with the key that came through the channel, and checked against the plaintext size and SHA-256 the client sent.
   */
  private async downloadSealed(sessionId: string, path: string, source: AttachmentSource, signal?: AbortSignal): Promise<LocalAttachment> {
    const sha256 = source.sha256?.replace(/^sha256:/u, '') ?? ''
    if (this.openSealed === undefined) throw new WorkspaceError('e2ee_attachment_unsupported', `attachment ${source.fileId} is sealed and this device cannot open it`)
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new WorkspaceError('attachment_corrupt', `attachment ${source.fileId}: a sealed upload needs its sha256`)
    const parts: Buffer[] = []
    for await (const chunk of await this.fetchFile(source.fileId, sessionId, signal)) parts.push(Buffer.from(chunk))
    let plaintext: Buffer
    try {
      plaintext = this.openSealed(Buffer.concat(parts), source.sealedKey!, sha256)
    } catch {
      throw new WorkspaceError('attachment_corrupt', `attachment ${source.fileId}: the sealed upload does not open with its key`)
    }
    if (plaintext.length !== source.size) throw new WorkspaceError('attachment_corrupt', `attachment ${source.fileId}: got ${plaintext.length} bytes, expected ${source.size}`)
    if (createHash('sha256').update(plaintext).digest('hex') !== sha256) throw new WorkspaceError('attachment_corrupt', `attachment ${source.fileId}: sha256 mismatch`)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.part-${randomBytes(4).toString('hex')}`
    try {
      await writeFile(tmp, plaintext, { flag: 'wx', mode: 0o600 })
      await rename(tmp, path)
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
    return { path, name: source.name, mediaType: source.mediaType, size: plaintext.length }
  }

  /** Removes the local copies of a session's attachments (archive or delete). */
  public async forget(sessionId: string): Promise<void> {
    const sessionDir = createHash('sha256').update(sessionId).digest('hex').slice(0, 24)
    await rm(join(this.dir, sessionDir), { recursive: true, force: true })
  }
}
