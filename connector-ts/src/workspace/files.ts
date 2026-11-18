// ported from effi-crew cloud/agentd/src/workspace/files.ts @30f8334 (MIME table, chunked download)
// ported from effi-crew cloud/agentd/src/workspace/write.ts @30f8334 (atomic writes)
// ported from Agents-Anywhere v2 connector/connector/local/file_ops.py @98dd0e6e5 (FileOps)
//
// The workspace file methods (`fs.readDir`, `fs.readText`, `fs.writeFile`, `fs.prepareDownload`) with the 2.x
// request and response shapes: at most 500 entries, 4 MiB reads, `ifMatch` optimistic locking, Windows drive
// letters. Paths are checked against the allowed roots (04-connector.md §8).
import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream, existsSync } from 'node:fs'
import { access, chmod, lstat, open, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

import { WorkspaceError, fsError, invalid, notFound } from './errors.js'
import {
  DEFAULT_READ_TEXT_BYTES,
  MAX_DIR_ENTRIES,
  MAX_READ_TEXT_BYTES,
  checkEncoding,
  nearestExistingDir,
  requiredString,
  requiredText,
  resolvePath,
  workspaceRoot,
  type Params,
} from './params.js'
import { expandHome, type RootPolicy } from './roots.js'

export const WRITE_MAX_BYTES = 32 * 1024 * 1024
export const DOWNLOAD_CHUNK_BYTES = 256 * 1024
/** `FILE_CHUNK_MAX_BYTES` (contracts/e2ee/1.0): the largest slice one channel read returns. */
export const FILE_CHUNK_MAX_BYTES = 8 * 1024 * 1024

/** `TunnelFileChunk` (contracts/e2ee/1.0): one slice of a file read through a secure channel. */
export interface FileChunk {
  encoding: 'base64'
  data: string
  offset: number
  size: number
  eof: boolean
}

export interface DirEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'other'
  size: number | null
}

export interface ReadDirResult {
  path: string
  entries: DirEntry[]
  truncated: boolean
  targetPath: string
  targetType: 'directory' | 'file' | 'other' | 'missing'
}

export interface ReadTextResult {
  path: string
  name: string
  size: number
  sha256: string
  encoding: 'utf8'
  content: string
  truncated: boolean
  binary: boolean
}

export interface WriteFileResult {
  path: string
  encoding: 'utf8'
  bytesWritten: number
  sha256: string
}

export interface PreparedDownload {
  path: string
  name: string
  size: number
  sha256: string
  mediaType: string
}

const MIME: Readonly<Record<string, string>> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.log': 'text/plain',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.jsx': 'text/javascript',
  '.ts': 'text/typescript', '.tsx': 'text/typescript', '.mts': 'text/typescript', '.cts': 'text/typescript',
  '.json': 'application/json', '.jsonl': 'application/jsonl', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.toml': 'application/toml', '.ini': 'text/plain', '.env': 'text/plain',
  '.py': 'text/x-python', '.go': 'text/x-go', '.rs': 'text/x-rust', '.java': 'text/x-java', '.kt': 'text/x-kotlin',
  '.c': 'text/x-c', '.h': 'text/x-c', '.cc': 'text/x-c++', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++',
  '.rb': 'text/x-ruby', '.php': 'text/x-php', '.swift': 'text/x-swift', '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript', '.zsh': 'text/x-shellscript', '.sql': 'application/sql', '.vue': 'text/x-vue',
  '.svelte': 'text/x-svelte', '.lua': 'text/x-lua', '.dockerfile': 'text/x-dockerfile',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
}

/** MIME type from the file name; undefined when the extension is unknown. */
export function mimeOf(path: string): string | undefined {
  const base = basename(path)
  if (base === 'Dockerfile') return 'text/x-dockerfile'
  if (base === 'Makefile') return 'text/x-makefile'
  return MIME[extname(base).toLowerCase()]
}

async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
    size += (chunk as Buffer).length
  }
  return { sha256: hash.digest('hex'), size }
}

async function regularFile(path: string): Promise<{ size: number }> {
  const info = await stat(path).catch((error: unknown) => {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? notFound(`file not found: ${path}`) : fsError(error, path)
  })
  if (!info.isFile()) throw notFound(`file not found: ${path}`)
  return { size: info.size }
}

/** Where a write lands: a symlink's target when it resolves, else the path; with the mode to keep. */
async function writeTarget(file: string): Promise<{ target: string; mode?: number }> {
  const own = await lstat(file).catch(() => undefined)
  if (own === undefined) return { target: file }
  let target = file
  let info = own
  if (own.isSymbolicLink()) {
    const resolved = await realpath(file).catch(() => undefined)
    if (resolved === undefined) return { target: file }
    target = resolved
    info = await stat(resolved)
  }
  if (info.isDirectory()) throw invalid(`is a directory, not a file: ${file}`)
  if (!info.isFile()) throw invalid(`not a regular file: ${file}`)
  return { target, mode: info.mode & 0o7777 }
}

export class FileOps {
  public constructor(
    private readonly policy: RootPolicy,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  private async driveEntries(): Promise<DirEntry[]> {
    if (!this.policy.unrestricted) {
      return (await this.policy.existingRoots()).map(root => ({ name: root, path: root, type: 'directory', size: null }))
    }
    const entries: DirEntry[] = []
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code)
      const path = `${letter}:\\`
      if (existsSync(path)) entries.push({ name: `${letter}:`, path, type: 'directory', size: null })
    }
    return entries
  }

  /** The first usable directory in preference order, using the same checks as an explicit listing. */
  private async readDefaultDir(): Promise<ReadDirResult> {
    const home = expandHome('~')
    const candidates = [home, ...await this.policy.roots()]
    for (const root of new Set(candidates)) {
      try {
        const listing = await this.readDir({ root })
        if (listing.targetType === 'directory' && listing.path === listing.targetPath) {
          await access(listing.path, constants.X_OK).catch(error => { throw fsError(error, listing.path) })
          return listing
        }
      } catch (error) {
        if (!(error instanceof WorkspaceError) || !['permission_denied', 'not_found', 'invalid_argument'].includes(error.code)) throw error
      }
    }
    return { path: '', entries: [], truncated: false, targetPath: '', targetType: 'missing' }
  }

  /** `fs.readDir`: a directory listing, or the nearest existing parent of a missing or file target. */
  public async readDir(params: Params): Promise<ReadDirResult> {
    if (params.defaultWorkspace === true) return this.readDefaultDir()
    const root = workspaceRoot(params)
    const rawPath = params.path
    if (this.platform === 'win32' && rawPath === '') {
      return { path: '', entries: await this.driveEntries(), truncated: false, targetPath: '', targetType: 'directory' }
    }
    const target = rawPath === undefined || rawPath === null ? root : resolvePath(root, requiredString(params, 'path'))
    await this.policy.check(target)
    const info = await stat(target).catch(() => undefined)
    const targetType: ReadDirResult['targetType'] = info === undefined ? 'missing' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    let dir = await nearestExistingDir(target, root)
    if (!(await this.policy.allows(dir))) dir = await nearestExistingDir(root)
    await this.policy.check(dir)

    const names = (await readdir(dir).catch((error: unknown) => {
      throw fsError(error, dir)
    })).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const visible = names.slice(0, MAX_DIR_ENTRIES)
    const targetName = basename(target)
    if (targetType === 'file' && dirname(target) === dir && !visible.includes(targetName) && visible.length > 0) {
      visible[visible.length - 1] = targetName
    }
    const entries = await Promise.all(visible.map(async (name): Promise<DirEntry> => {
      const path = join(dir, name)
      const child = await stat(path).catch(() => undefined)
      const type = child?.isDirectory() === true ? 'directory' : child?.isFile() === true ? 'file' : 'other'
      return { name, path, type, size: child !== undefined && child.isFile() ? child.size : null }
    }))
    return { path: dir, entries, truncated: names.length > MAX_DIR_ENTRIES, targetPath: target, targetType }
  }

  /** `fs.readText`: up to `maxBytes` (default 1 MiB, at most 4 MiB) and the sha256 of the whole file. */
  public async readText(params: Params): Promise<ReadTextResult> {
    const path = resolvePath(workspaceRoot(params), requiredString(params, 'path'))
    await this.policy.check(path)
    await regularFile(path)
    const rawMax = params.maxBytes ?? DEFAULT_READ_TEXT_BYTES
    if (typeof rawMax !== 'number' || !Number.isInteger(rawMax)) throw invalid('maxBytes must be an integer')
    const maxBytes = Math.min(Math.max(rawMax, 1), MAX_READ_TEXT_BYTES)
    const handle = await open(path, 'r').catch((error: unknown) => {
      throw fsError(error, path)
    })
    let clipped: Buffer
    try {
      const buffer = Buffer.alloc(maxBytes)
      let filled = 0
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      clipped = buffer.subarray(0, filled)
    } finally {
      await handle.close()
    }
    const { sha256, size } = await sha256File(path)
    const binary = clipped.includes(0)
    return {
      path,
      name: basename(path),
      size,
      sha256,
      encoding: 'utf8',
      content: binary ? '' : new TextDecoder('utf-8').decode(clipped),
      truncated: size > clipped.length,
      binary,
    }
  }

  /**
   * `fs.writeFile`: UTF-8 text, written to a temp file and renamed into place (keeping the mode of the file it
   * replaces, writing through a symlink to its target). With `ifMatch` the file must still have that sha256
   * (`stale` otherwise); `ifMatch: ""` skips the comparison when the file exists and accepts a missing file.
   */
  public async writeFile(params: Params): Promise<WriteFileResult> {
    const path = resolvePath(workspaceRoot(params), requiredString(params, 'path'))
    await this.policy.check(path)
    checkEncoding(params)
    const content = requiredText(params, 'content')
    const ifMatch = params.ifMatch
    const parent = await stat(dirname(path)).catch(() => undefined)
    if (parent?.isDirectory() !== true) throw notFound(`parent directory not found: ${dirname(path)}`)
    if (ifMatch !== undefined && ifMatch !== null) {
      if (typeof ifMatch !== 'string') throw invalid('ifMatch must be a sha256 hex string')
      const current = await stat(path).catch(() => undefined)
      let currentHash = ''
      if (current?.isFile() === true) currentHash = (await sha256File(path)).sha256
      else if (ifMatch !== '') throw new WorkspaceError('stale', `file disappeared (expected sha256=${ifMatch})`)
      if (ifMatch !== '' && currentHash !== ifMatch) {
        throw new WorkspaceError('stale', `file changed on disk (expected sha256=${ifMatch}, found sha256=${currentHash === '' ? 'none' : currentHash})`)
      }
    }
    const data = Buffer.from(content, 'utf8')
    if (data.length > WRITE_MAX_BYTES) throw invalid(`fs.writeFile takes at most ${WRITE_MAX_BYTES / 1024 / 1024} MiB`)
    const { target, mode } = await writeTarget(path).catch((error: unknown) => {
      throw fsError(error, path, 'write')
    })
    const tmp = join(dirname(target), `.${basename(target)}.aa-write-${randomBytes(4).toString('hex')}`)
    try {
      await writeFile(tmp, data, { flag: 'wx' }).catch((error: unknown) => {
        throw fsError(error, path, 'write')
      })
      if (mode !== undefined) await chmod(tmp, mode)
      await rename(tmp, target).catch((error: unknown) => {
        throw fsError(error, path, 'write')
      })
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
    return { path, encoding: 'utf8', bytesWritten: data.length, sha256: createHash('sha256').update(data).digest('hex') }
  }

  /** `fs.prepareDownload`: what a download of the file will contain. */
  public async prepareDownload(params: Params): Promise<PreparedDownload> {
    const path = await this.preparedDownloadPath(params)
    await regularFile(path)
    const { sha256, size } = await sha256File(path)
    return { path, name: basename(path), size, sha256, mediaType: mimeOf(path) ?? 'application/octet-stream' }
  }

  /** The checked path of a prepared download. */
  public async preparedDownloadPath(params: Params): Promise<string> {
    const path = resolvePath(workspaceRoot(params), requiredString(params, 'path'))
    await this.policy.check(path)
    return path
  }

  /**
   * The file a prepared download sends (`fs.uploadPreparedDownload`): checked like `prepareDownload`, readable, but
   * not hashed again (the size is what the upload declares).
   */
  public async preparedFile(params: Params): Promise<{ path: string; size: number; mediaType: string }> {
    const path = await this.preparedDownloadPath(params)
    const { size } = await regularFile(path)
    await access(path, constants.R_OK).catch((error: unknown) => {
      throw fsError(error, path)
    })
    return { path, size, mediaType: mimeOf(path) ?? 'application/octet-stream' }
  }

  /** The file in chunks of 256 KiB. Checked (exists, readable) before returning so a bad path fails the call. */
  public async openDownload(params: Params, signal?: AbortSignal): Promise<AsyncGenerator<Buffer>> {
    const path = await this.preparedDownloadPath(params)
    await regularFile(path)
    await access(path, constants.R_OK).catch((error: unknown) => {
      throw fsError(error, path)
    })
    return (async function* chunks() {
      const stream = createReadStream(path, { highWaterMark: DOWNLOAD_CHUNK_BYTES })
      try {
        for await (const chunk of stream) {
          if (signal?.aborted === true) return
          yield chunk as Buffer
        }
      } finally {
        stream.destroy()
      }
    })()
  }

  /**
   * `GET fs/read?root&path&offset&length` through a secure channel (E2EE has no download URL): at most
   * `FILE_CHUNK_MAX_BYTES` from `offset`. Same root and path checks as a download.
   */
  public async readRange(params: Params): Promise<FileChunk> {
    const path = await this.preparedDownloadPath(params)
    const { size } = await regularFile(path)
    const offset = Number(params.offset ?? 0)
    const wanted = Number(params.length ?? FILE_CHUNK_MAX_BYTES)
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('offset must be a non-negative integer')
    if (!Number.isSafeInteger(wanted) || wanted < 1) throw invalid('length must be a positive integer')
    const length = Math.min(wanted, FILE_CHUNK_MAX_BYTES, Math.max(0, size - offset))
    const buffer = Buffer.alloc(length)
    let read = 0
    if (length > 0) {
      const handle = await open(path, 'r').catch((error: unknown) => {
        throw fsError(error, path)
      })
      try {
        while (read < length) {
          const { bytesRead } = await handle.read(buffer, read, length - read, offset + read)
          if (bytesRead === 0) break
          read += bytesRead
        }
      } finally {
        await handle.close()
      }
    }
    return { encoding: 'base64', data: buffer.subarray(0, read).toString('base64'), offset, size, eof: offset + read >= size }
  }
}
