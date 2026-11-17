// Prompt attachments on this device: a Server file id is downloaded once into the data directory and handed to the
// Runtime as a local path (04-connector.md §5: Codex and others take a path, so no data URL bloats native history).
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
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

/** An attachment already on this device, as `Store/readBlob` hands it out: the local file and its plaintext digest. */
export interface StoredAttachment extends LocalAttachment {
  readonly fileId: string
  /** SHA-256 (hex) of the local file, i.e. the plaintext. */
  readonly sha256: string
}

/**
 * A download reached the disk (file and metadata fsynced and renamed). `sha256` is the digest of the bytes the
 * Server holds — the plaintext, or the ciphertext of a sealed upload — which is what its staged copy records and
 * what `attachment.consumed` must carry for the Server to drop that copy.
 */
export interface AttachmentStored {
  readonly sessionId: string
  readonly fileId: string
  readonly sha256: string
}

export interface AttachmentCacheOptions {
  /** Called once per first download, after it is durable; a rejection is ignored (the copy stays usable). */
  readonly onStored?: (stored: AttachmentStored) => Promise<void> | void
}

/** Next to the downloaded file; `safeFileName` never yields a leading dot, so it cannot collide with one. */
export const ATTACHMENT_META = '.aa-meta.json'

interface AttachmentMeta {
  readonly fileId: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
  /** Plaintext SHA-256 (hex) of the local file. */
  readonly sha256: string
  /** SHA-256 (hex) of the bytes the Server stores (the ciphertext of a sealed upload). */
  readonly storedSha256: string
}

/** Flushes a file (or, best effort, a directory) to the disk. */
async function fsyncPath(path: string, directory = false): Promise<void> {
  let handle
  try {
    handle = await open(path, directory ? 'r' : 'r+')
    await handle.sync()
  } catch (error) {
    if (!directory) throw error
    // Directories cannot be opened or fsynced everywhere (Windows); the rename itself is still atomic.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
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
    private readonly options: AttachmentCacheOptions = {},
  ) {}

  private dirOf(sessionId: string, fileId: string): string {
    const sessionDir = createHash('sha256').update(sessionId).digest('hex').slice(0, 24)
    return join(this.dir, sessionDir, safeFileName(fileId))
  }

  private pathOf(sessionId: string, source: AttachmentSource): string {
    return join(this.dirOf(sessionId, source.fileId), safeFileName(source.name))
  }

  /**
   * The local copy of `fileId` in a session, or null. Without metadata (a download from before it was written)
   * the only file in the directory is taken, its digest computed and its type unknown.
   */
  public async find(sessionId: string, fileId: string): Promise<StoredAttachment | null> {
    const dir = this.dirOf(sessionId, fileId)
    const meta = await readFile(join(dir, ATTACHMENT_META), 'utf8').then(text => JSON.parse(text) as Partial<AttachmentMeta>).catch(() => null)
    if (meta !== null && typeof meta.name === 'string' && typeof meta.sha256 === 'string' && typeof meta.size === 'number') {
      const path = join(dir, safeFileName(meta.name))
      const existing = await stat(path).catch(() => undefined)
      if (existing?.isFile() === true && existing.size === meta.size) {
        return { fileId, path, name: meta.name, mediaType: typeof meta.mediaType === 'string' && meta.mediaType !== '' ? meta.mediaType : 'application/octet-stream', size: meta.size, sha256: meta.sha256 }
      }
    }
    const names = (await readdir(dir).catch(() => [] as string[])).filter(name => !name.startsWith(ATTACHMENT_META) && !/\.part-[0-9a-f]{8}$/u.test(name))
    const files: { name: string; size: number }[] = []
    for (const name of names) {
      const entry = await stat(join(dir, name)).catch(() => undefined)
      if (entry?.isFile() === true) files.push({ name, size: entry.size })
    }
    if (files.length !== 1) return null
    const path = join(dir, files[0]!.name)
    return { fileId, path, name: files[0]!.name, mediaType: 'application/octet-stream', size: files[0]!.size, sha256: await sha256OfFile(path) }
  }

  /**
   * Makes a finished temporary file durable under its name with its metadata: both are fsynced before their
   * renames, the file first (a crash in between leaves a file without metadata, which `find` still serves).
   * Then the Server hears that it may drop its staged copy.
   */
  private async commit(sessionId: string, tmp: string, path: string, meta: AttachmentMeta): Promise<void> {
    await fsyncPath(tmp)
    const metaPath = join(dirname(path), ATTACHMENT_META)
    const metaTmp = `${metaPath}.meta-${randomBytes(4).toString('hex')}`
    const handle = await open(metaTmp, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(meta))
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tmp, path)
      await rename(metaTmp, metaPath)
    } finally {
      await unlink(metaTmp).catch(() => undefined)
    }
    await fsyncPath(dirname(path), true)
    try {
      await this.options.onStored?.({ sessionId, fileId: meta.fileId, sha256: meta.storedSha256 })
    } catch {
      // The local copy is fine; the Server just keeps its staged copy until it expires.
    }
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
        createWriteStream(tmp, { flags: 'wx', mode: 0o600 }),
        ...(signal === undefined ? [] : [{ signal }]),
      )
      if (size !== source.size) throw new WorkspaceError('attachment_corrupt', `attachment ${source.fileId}: got ${size} bytes, expected ${source.size}`)
      const digest = hash.digest('hex')
      const expected = source.sha256?.replace(/^sha256:/u, '')
      if (expected !== undefined && expected !== null && expected !== '' && expected !== digest) {
        throw new WorkspaceError('attachment_corrupt', `attachment ${source.fileId}: sha256 mismatch`)
      }
      // The Server's staged copy records the digest of exactly these bytes.
      await this.commit(sessionId, tmp, path, { fileId: source.fileId, name: source.name, mediaType: source.mediaType, size, sha256: digest, storedSha256: digest })
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
    const ciphertext = Buffer.concat(parts)
    // contracts/device-meshcall/1.0 e2ee-registration: `attachment.consumed` carries the digest of the stored ciphertext.
    const storedSha256 = createHash('sha256').update(ciphertext).digest('hex')
    let plaintext: Buffer
    try {
      plaintext = this.openSealed(ciphertext, source.sealedKey!, sha256)
    } catch {
      throw new WorkspaceError('attachment_corrupt', `attachment ${source.fileId}: the sealed upload does not open with its key`)
    }
    if (plaintext.length !== source.size) throw new WorkspaceError('attachment_corrupt', `attachment ${source.fileId}: got ${plaintext.length} bytes, expected ${source.size}`)
    if (createHash('sha256').update(plaintext).digest('hex') !== sha256) throw new WorkspaceError('attachment_corrupt', `attachment ${source.fileId}: sha256 mismatch`)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.part-${randomBytes(4).toString('hex')}`
    try {
      const handle = await open(tmp, 'wx', 0o600)
      try {
        await handle.writeFile(plaintext)
      } finally {
        await handle.close()
      }
      await this.commit(sessionId, tmp, path, { fileId: source.fileId, name: source.name, mediaType: source.mediaType, size: plaintext.length, sha256, storedSha256 })
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
    return { path, name: source.name, mediaType: source.mediaType, size: plaintext.length }
  }

  /** Removes the local copies of a session's attachments (archive or delete). */
  public async forget(sessionId: string): Promise<void> {
    await rm(dirname(this.dirOf(sessionId, 'x')), { recursive: true, force: true })
  }
}
