import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { createServer, type ListenOptions } from 'node:net'
import { dirname } from 'node:path'

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8')
    try { return JSON.parse(text) as T } catch { throw new Error('本地状态文件格式无效，请检查插件数据目录。') }
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  }
}

/** The manager lock serializes writers; rename publishes a complete file. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await file.sync()
    } finally { await file.close() }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

// 16384-32767 lies below every default dynamic port range (Linux 32768+, Windows and macOS
// 49152+), so ephemeral client sockets and listen(0) servers never land on a lease port.
const LEASE_PORTS = 16384
// Plugins released before the lease moved used one port in 49152-65535.
const LEGACY_LEASE_PORTS = 49152

/** The lease port derived from a directory, in the range starting at `first`. */
export function managerLockPort(identity: string, first = LEASE_PORTS): number {
  return first + createHash('sha256').update(identity).digest().readUInt16BE(0) % 16384
}

/**
 * On Windows the lease is a named pipe: pipes have no reserved ranges or ephemeral sockets, and
 * libuv creates the first instance exclusively, so a second listener fails with EADDRINUSE.
 * Elsewhere it is one loopback port; those systems do not reserve ports in this range.
 */
function leaseAddress(identity: string): ListenOptions {
  if (process.platform === 'win32') {
    return { path: String.raw`\\.\pipe\agents-anywhere-lease-` + createHash('sha256').update(identity).digest('hex') }
  }
  return { host: '127.0.0.1', port: managerLockPort(identity), exclusive: true }
}

export function acquireManagerLock(path: string, onCompromised?: () => void): Promise<() => Promise<void>> {
  return acquireLease(path, leaseAddress, onCompromised)
}

/**
 * Leases `path` the way this plugin does and the way older plugins did, for paths an older plugin
 * may still use (the legacy endpoint and data directory). When the OS refuses the older plugins'
 * port with EACCES, they cannot lease the path either, so this plugin's lease alone suffices.
 */
export async function acquireCompatibleManagerLock(path: string): Promise<() => Promise<void>> {
  const release = await acquireManagerLock(path)
  try {
    const releaseLegacy = await acquireLease(path, identity => (
      { host: '127.0.0.1', port: managerLockPort(identity, LEGACY_LEASE_PORTS), exclusive: true }))
    return async () => { try { await releaseLegacy() } finally { await release() } }
  } catch (error) {
    if (hasCode(error, 'EACCES')) return release
    await release()
    throw error
  }
}

async function acquireLease(path: string, address: (identity: string) => ListenOptions,
  onCompromised?: () => void): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const directory = await realpath(dirname(path))
  const options = address(process.platform === 'win32' ? directory.toLowerCase() : directory)
  // The OS releases this lease even after SIGKILL. File-based stale takeover
  // cannot atomically check ownership before deleting a reused path.
  // This is not an HTTP/RPC endpoint; incoming connections are immediately closed.
  const lease = createServer(socket => socket.destroy())
  try {
    await new Promise<void>((resolve, reject) => {
      lease.once('error', reject)
      lease.listen(options, () => {
        lease.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    const where = options.port === undefined ? '通道' : `端口 ${options.port}`
    if (hasCode(error, 'EADDRINUSE')) throw new Error(`另一个插件实例正在管理本机设备，或本机管理${where}已被占用。请关闭该实例后重试。`)
    throw error
  }
  lease.unref()
  let released = false
  const lost = () => { if (!released) onCompromised?.() }
  lease.on('error', lost)
  lease.on('close', lost)
  return async () => {
    if (released) return
    released = true
    await new Promise<void>((resolve, reject) => lease.close(error => error ? reject(error) : resolve()))
  }
}
