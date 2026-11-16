// Prompt attachments on this device: a Server file id is downloaded once into the data directory and handed to the
// Runtime as a local path (04-connector.md §5: Codex and others take a path, so no data URL bloats native history).
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { WorkspaceError } from './errors.js'

export interface AttachmentSource {
  readonly fileId: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
  readonly sha256?: string | null
}

export interface LocalAttachment {
  readonly path: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
}

/** Fetches the bytes of a Server file (the link layer supplies it: HTTPS with the device token and egress). */
export type FetchFile = (fileId: string, signal?: AbortSignal) => Promise<AsyncIterable<Uint8Array>>

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
      running = this.download(path, source, signal).finally(() => this.inFlight.delete(path))
      this.inFlight.set(path, running)
    }
    return running
  }

  private async download(path: string, source: AttachmentSource, signal?: AbortSignal): Promise<LocalAttachment> {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.part-${randomBytes(4).toString('hex')}`
    const hash = createHash('sha256')
    let size = 0
    try {
      const body = await this.fetchFile(source.fileId, signal)
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

  /** Removes the local copies of a session's attachments (archive or delete). */
  public async forget(sessionId: string): Promise<void> {
    const sessionDir = createHash('sha256').update(sessionId).digest('hex').slice(0, 24)
    await rm(join(this.dir, sessionDir), { recursive: true, force: true })
  }
}
