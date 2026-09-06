import { chmod, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export interface StateLayout {
  dshHome: string
  stateRoot: string
  endpointPath: string
  lockPath: string
}

export async function prepareStateLayout(dshHomeInput: string, stateRootInput: string): Promise<StateLayout> {
  if (!isAbsolute(dshHomeInput) || !isAbsolute(stateRootInput)) {
    throw new Error('dshHome and stateRoot must be absolute paths')
  }
  const dshHome = await existingDirectory(resolve(dshHomeInput), 'dshHome', false)
  const requestedRoot = resolve(stateRootInput)
  await assertNotSymlink(requestedRoot, true)
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(requestedRoot, 0o700)
  const stateRoot = await existingDirectory(requestedRoot, 'stateRoot', true)
  const relation = relative(dshHome, stateRoot)
  if (relation === '' || relation === '..' || relation.startsWith(`..${pathSeparator()}`) || isAbsolute(relation)) {
    throw new Error('stateRoot must be a descendant of canonical dshHome')
  }
  return {
    dshHome,
    stateRoot,
    endpointPath: resolve(stateRoot, 'endpoint.json'),
    // The lock belongs to the canonical DSH_HOME, not to a configurable state
    // subdirectory. Two bridge configs for the same Host must still contend.
    lockPath: resolve(dshHome, '.agents-anywhere-dsh-bridge.lock'),
  }
}

async function existingDirectory(path: string, label: string, ownerOnly: boolean): Promise<string> {
  const linkMetadata = await lstat(path)
  if (linkMetadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
  const canonical = await realpath(path)
  const metadata = await stat(canonical)
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`)
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`)
  }
  if (process.platform !== 'win32') {
    const forbidden = ownerOnly ? 0o077 : 0o022
    if ((metadata.mode & forbidden) !== 0) {
      throw new Error(ownerOnly
        ? `${label} must not grant group or other permissions`
        : `${label} must not be writable by group or other users`)
    }
  }
  return canonical
}

async function assertNotSymlink(path: string, allowMissing: boolean): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('stateRoot must not be a symbolic link')
  } catch (error: unknown) {
    if (allowMissing && isMissing(error)) return
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}
