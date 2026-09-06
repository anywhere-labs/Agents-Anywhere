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

export async function acquireManagerLock(path: string, onCompromised?: () => void): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const directory = await realpath(dirname(path))
  const identity = process.platform === 'win32' ? directory.toLowerCase() : directory
  const port = 49152 + createHash('sha256').update(identity).digest().readUInt16BE(0) % 16384
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
    if (hasCode(error, 'EADDRINUSE')) throw new Error(`另一个插件实例正在管理本机设备，或本机管理端口 ${port} 已被占用。请关闭该实例后重试。`)
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
