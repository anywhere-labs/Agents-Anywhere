import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BridgeError } from '../wire/errors.js'

const MAX_METADATA_BYTES = 1024 * 1024

export async function readOptionalJsonSecure<T>(path: string): Promise<T | undefined> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw persistenceFailure('metadata stat failed', error)
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > MAX_METADATA_BYTES) {
      throw persistenceFailure('metadata path is not a bounded regular file')
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw persistenceFailure('metadata file has a different owner')
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw persistenceFailure('metadata file grants group or other permissions')
    }
    return JSON.parse(await handle.readFile('utf8')) as T
  } catch (error: unknown) {
    if (error instanceof BridgeError) throw error
    throw persistenceFailure(error instanceof SyntaxError ? 'metadata contains invalid JSON' : 'metadata read failed', error)
  } finally {
    await handle.close()
  }
}

export async function readJsonDirectorySecure<T>(path: string): Promise<T[]> {
  await ensurePrivateDirectory(path)
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error: unknown) {
    throw persistenceFailure('metadata directory read failed', error)
  }
  if (entries.length > 10_000) throw persistenceFailure('metadata directory contains too many entries')
  const records: T[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith('.json')) {
      throw persistenceFailure('metadata directory contains an unexpected entry')
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw persistenceFailure('metadata directory entry is not a regular file')
    }
    const value = await readOptionalJsonSecure<T>(join(path, entry.name))
    if (value === undefined) throw persistenceFailure('metadata entry disappeared while reading')
    records.push(value)
  }
  return records
}

export async function writeJsonAtomicSecure(path: string, value: unknown): Promise<void> {
  const parent = dirname(path)
  await ensurePrivateDirectory(parent)
  const temporary = join(parent, `.${randomUUID()}.tmp`)
  try {
    await writeTemporary(temporary, value)
    await rename(temporary, path)
    if (process.platform !== 'win32') await chmod(path, 0o600)
    await syncDirectory(parent)
  } catch (error: unknown) {
    await unlink(temporary).catch(ignoreMissing)
    throw persistenceFailure('atomic metadata publish failed', error)
  }
}

export async function writeJsonNoClobberSecure(
  path: string,
  value: unknown,
): Promise<'created' | 'exists'> {
  const parent = dirname(path)
  await ensurePrivateDirectory(parent)
  const temporary = join(parent, `.${randomUUID()}.tmp`)
  try {
    await writeTemporary(temporary, value)
    await link(temporary, path)
    await unlink(temporary)
    await syncDirectory(parent)
    return 'created'
  } catch (error: unknown) {
    await unlink(temporary).catch(ignoreMissing)
    if (isNodeError(error, 'EEXIST')) return 'exists'
    throw persistenceFailure('no-clobber metadata publish failed', error)
  }
}

async function writeTemporary(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } catch (error: unknown) {
    await handle.close().catch(() => undefined)
    await unlink(path).catch(ignoreMissing)
    throw error
  }
  await handle.close()
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const linkMetadata = await lstat(path)
    if (linkMetadata.isSymbolicLink()) throw persistenceFailure('metadata directory is a symbolic link')
    const metadata = await stat(path)
    if (!metadata.isDirectory()) throw persistenceFailure('metadata directory is not a directory')
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw persistenceFailure('metadata directory has a different owner')
    }
    if (process.platform !== 'win32') {
      if ((metadata.mode & 0o077) !== 0) throw persistenceFailure('metadata directory grants group or other permissions')
      await chmod(path, 0o700)
    }
  } catch (error: unknown) {
    if (error instanceof BridgeError) throw error
    throw persistenceFailure('metadata directory validation failed', error)
  }
}

export async function removeRegularFile(path: string): Promise<void> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return
    throw persistenceFailure('metadata stat failed', error)
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw persistenceFailure('refusing to remove a non-regular metadata path')
  }
  try {
    await unlink(path)
    await syncDirectory(dirname(path))
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) throw persistenceFailure('metadata removal failed', error)
  }
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
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

function ignoreMissing(error: unknown): void {
  if (!isNodeError(error, 'ENOENT')) throw error
}

function persistenceFailure(details: string, cause?: unknown): BridgeError {
  return new BridgeError('PERSISTENCE_ERROR', 'Bridge metadata could not be read or written.', {
    retryable: false,
    details: { reason: details },
  }, { cause })
}
