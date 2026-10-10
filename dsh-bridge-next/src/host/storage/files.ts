import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
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
// Plugins released before the lease ports moved used 49152-65535.
const LEGACY_LEASE_PORTS = 49152

/** Lease ports in trial order: 16 candidates spread evenly, far apart from the 100-port blocks Windows reserves. */
export function managerLockPorts(identity: string, first = LEASE_PORTS): number[] {
  const base = createHash('sha256').update(identity).digest().readUInt16BE(0) % 16384
  return Array.from({ length: 16 }, (_, k) => first + (base + 1024 * k) % 16384)
}

export function acquireManagerLock(path: string, onCompromised?: () => void): Promise<() => Promise<void>> {
  return acquireLease(path, LEASE_PORTS, onCompromised)
}

/**
 * The lease an older plugin takes on `path`. Only for excluding such plugins from paths they
 * still use (the legacy endpoint and data directory), never for this plugin's own ownership.
 */
export function acquireLegacyManagerLock(path: string): Promise<() => Promise<void>> {
  return acquireLease(path, LEGACY_LEASE_PORTS)
}

async function acquireLease(path: string, first: number, onCompromised?: () => void): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const directory = await realpath(dirname(path))
  // The OS releases this loopback lease even after SIGKILL. File-based stale
  // takeover cannot atomically check ownership before deleting a reused path.
  // This is not an HTTP/RPC endpoint; incoming sockets are immediately closed.
  const lease = await claimLease(managerLockPorts(process.platform === 'win32' ? directory.toLowerCase() : directory, first))
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

export const RESERVED_LEASE_PORTS = '系统保留了插件的全部本机管理端口'

/**
 * Binds the first candidate the OS allows. EACCES means no instance can bind the port (a Windows
 * excluded port range, or another program's exclusive bind on 0.0.0.0), so every instance moves
 * on to the same next port; a held port is never skipped.
 */
async function claimLease(ports: number[]): Promise<Server> {
  let reserved: unknown
  for (const port of ports) {
    const lease = createServer(socket => socket.destroy())
    try {
      await new Promise<void>((resolve, reject) => {
        lease.once('error', reject)
        lease.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
          lease.off('error', reject)
          resolve()
        })
      })
      return lease
    } catch (error) {
      if (hasCode(error, 'EACCES')) { reserved = error; continue }
      if (hasCode(error, 'EADDRINUSE')) throw new Error(`另一个插件实例正在管理本机设备，或本机管理端口 ${port} 已被占用。请关闭该实例后重试。`)
      throw error
    }
  }
  throw new Error(`${RESERVED_LEASE_PORTS}，无法确认只有一个插件实例在运行。`, { cause: reserved })
}
