import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, open, readFile, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isNodeError } from './files.js'

const MAX_LOCK_BYTES = 16 * 1024

interface LockRecord {
  version: 1
  pid: number
  token: string
  startedAt: string
  dshHome: string
}

export class ProcessLock {
  private handle: FileHandle | undefined
  private record: LockRecord | undefined

  constructor(
    private readonly path: string,
    private readonly dshHome: string,
  ) {}

  async acquire(): Promise<void> {
    if (this.handle !== undefined) throw new Error('bridge process lock is already held')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let created: FileHandle | undefined
      try {
        created = await open(this.path, 'wx', 0o600)
        const record: LockRecord = {
          version: 1,
          pid: process.pid,
          token: randomUUID(),
          startedAt: new Date().toISOString(),
          dshHome: this.dshHome,
        }
        await created.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
        await created.sync()
        await syncDirectory(dirname(this.path))
        this.handle = created
        this.record = record
        return
      } catch (error: unknown) {
        if (created !== undefined) {
          await created.close().catch(() => undefined)
          await unlink(this.path).catch(() => undefined)
        }
        if (!isNodeError(error, 'EEXIST') || attempt > 0) {
          throw new Error('another DSH Bridge process owns this DSH_HOME', { cause: error })
        }
        await this.removeStaleLock()
      }
    }
  }

  async release(): Promise<void> {
    const handle = this.handle
    const record = this.record
    this.handle = undefined
    this.record = undefined
    if (handle === undefined || record === undefined) return
    await handle.close()
    let current: LockRecord | undefined
    try {
      const metadata = await lstat(this.path)
      if (!validLockMetadata(metadata)) return
      current = JSON.parse(await readFile(this.path, 'utf8')) as LockRecord
    } catch {
      return
    }
    if (current.version === 1 && current.pid === process.pid && current.token === record.token) {
      await unlink(this.path).catch(() => undefined)
      await syncDirectory(dirname(this.path)).catch(() => undefined)
    }
  }

  private async removeStaleLock(): Promise<void> {
    const metadata = await lstat(this.path)
    if (!validLockMetadata(metadata)) {
      throw new Error('bridge lock path is not a regular private file')
    }
    let record: Partial<LockRecord>
    try {
      record = JSON.parse(await readFile(this.path, 'utf8')) as Partial<LockRecord>
    } catch (error: unknown) {
      throw new Error('bridge lock file is invalid; remove it after verifying no DSH process is running', { cause: error })
    }
    if (record.version !== 1
      || record.dshHome !== this.dshHome
      || typeof record.token !== 'string' || record.token.length === 0
      || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
      throw new Error('bridge lock file has invalid ownership metadata')
    }
    if (processExists(record.pid)) {
      throw new Error(`DSH Bridge is already running for this DSH_HOME (pid ${record.pid})`)
    }
    await unlink(this.path)
    await syncDirectory(dirname(this.path))
  }
}

function validLockMetadata(metadata: Stats): boolean {
  return !metadata.isSymbolicLink()
    && metadata.isFile()
    && metadata.size <= MAX_LOCK_BYTES
    && (typeof process.getuid !== 'function' || metadata.uid === process.getuid())
    && (process.platform === 'win32' || (metadata.mode & 0o077) === 0)
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if (isNodeError(error, 'ESRCH')) return false
    if (isNodeError(error, 'EPERM')) return true
    throw error
  }
}
