import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Content-addressed blob files under `<dataDir>/blobs/<aa>/<sha256>` (04-connector.md §6.3). Synchronous: it
 * runs on the store's worker thread next to SQLite. Writes go to a temporary file, are fsynced and renamed,
 * so a crash never leaves a truncated blob under its final name.
 */
export class BlobFiles {
  public constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }

  public static digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
  }

  public pathOf(sha256: string): string {
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error('invalid blob digest')
    return join(this.root, sha256.slice(0, 2), sha256)
  }

  /** Writes the bytes unless an identical blob exists; returns the digest. */
  public write(bytes: Uint8Array): string {
    const sha256 = BlobFiles.digest(bytes)
    const path = this.pathOf(sha256)
    if (existsSync(path) && statSync(path).size === bytes.byteLength) return sha256
    mkdirSync(join(this.root, sha256.slice(0, 2)), { recursive: true, mode: 0o700 })
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    const fd = openSync(temporary, 'w', 0o600)
    try {
      let offset = 0
      while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
    return sha256
  }

  public read(sha256: string, range?: { offset: number; length: number }): Uint8Array | null {
    const path = this.pathOf(sha256)
    if (!existsSync(path)) return null
    if (range === undefined) return readFileSync(path)
    const size = statSync(path).size
    const offset = Math.max(0, Math.min(range.offset, size))
    const length = Math.max(0, Math.min(range.length, size - offset))
    const buffer = Buffer.alloc(length)
    const fd = openSync(path, 'r')
    try {
      let done = 0
      while (done < length) {
        const read = readSync(fd, buffer, done, length - done, offset + done)
        if (read === 0) break
        done += read
      }
      return buffer.subarray(0, done)
    } finally {
      closeSync(fd)
    }
  }

  public exists(sha256: string): boolean {
    return existsSync(this.pathOf(sha256))
  }
}
