import { randomUUID } from 'node:crypto'
import { chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BridgeError } from '../wire/errors.js'

const MAX_METADATA_BYTES = 1024 * 1024

export async function readOptionalJsonSecure<T>(path: string): Promise<T | undefined> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw persistenceFailure('metadata stat failed', error)
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_METADATA_BYTES) {
    throw persistenceFailure('metadata path is not a bounded regular file')
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error: unknown) {
    throw persistenceFailure(error instanceof SyntaxError ? 'metadata contains invalid JSON' : 'metadata read failed', error)
  }
}

export async function writeJsonAtomicSecure(path: string, value: unknown): Promise<void> {
  const parent = dirname(path)
  const temporary = join(parent, `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
    if (process.platform !== 'win32') await chmod(path, 0o600)
    await syncDirectory(parent)
  } catch (error: unknown) {
    await unlink(temporary).catch(ignoreMissing)
    throw persistenceFailure('atomic metadata publish failed', error)
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
