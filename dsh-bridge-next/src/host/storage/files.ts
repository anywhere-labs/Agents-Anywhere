import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
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

/**
 * A lock port is derived from a shared directory, so every process competing for
 * that directory must derive the same port: the range is part of that contract and
 * cannot be randomized.
 *
 * It must also stay outside the operating system's ephemeral range. Windows hands
 * 49152-65535 to outbound sockets and lets Hyper-V/WSL reserve blocks inside it, so
 * a lock that lands there can be refused even while no owning process is visible.
 * 16384-32767 sits below the Windows and macOS dynamic range and below the Linux
 * default ephemeral start of 32768.
 */
const LOCK_PORT_BASE = 16384
const LOCK_PORT_SPAN = 16384

/** The loopback port that represents ownership of `directory` across processes on this host. */
export function managerLockPort(directory: string, platform = process.platform): number {
  const identity = platform === 'win32' ? directory.toLowerCase() : directory
  return LOCK_PORT_BASE + createHash('sha256').update(identity).digest().readUInt16BE(0) % LOCK_PORT_SPAN
}

/**
 * Windows refuses a bind that conflicts with an `SO_EXCLUSIVEADDRUSE` socket with
 * WSAEACCES rather than WSAEADDRINUSE, so both codes mean "this port is taken".
 * Handling only EADDRINUSE let the EACCES case fall through to the generic
 * permission branch, which blamed data-directory permissions and local-network
 * policy: neither can cause it. The port travels with the error so diagnostics can
 * report it without exposing the message.
 */
export class ManagerLockPortError extends Error {
  readonly code = 'LOCK_PORT_UNAVAILABLE'
  readonly port: number

  constructor(port: number, cause: unknown) {
    super(`另一个插件实例正在管理本机设备，或本机管理端口 ${port} 已被其他程序或系统保留段占用。请关闭该实例后重试。`, { cause })
    this.name = 'ManagerLockPortError'
    this.port = port
  }
}

export async function acquireManagerLock(path: string, onCompromised?: () => void): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const port = managerLockPort(await realpath(dirname(path)))
  // The OS releases this loopback lease even after SIGKILL. File-based stale
  // takeover cannot atomically check ownership before deleting a reused path.
  // This is not an HTTP/RPC endpoint; incoming sockets are immediately closed.
  const lease = createServer(socket => socket.destroy())
  try {
    await new Promise<void>((resolve, reject) => {
      lease.once('error', reject)
      lease.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        lease.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    if (hasCode(error, 'EADDRINUSE') || hasCode(error, 'EACCES')) throw new ManagerLockPortError(port, error)
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
