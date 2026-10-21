import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { createConnection, createServer, type AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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

export type ManagerLockRecord = { version: 1, port: number, pid: number, token: string, startedAt: string }

const LOCK_RECORD = '.manager-lock.json'
const LOCK_PROBE_TIMEOUT_MS = 1000
const LOCK_WATCH_INTERVAL_MS = 5000
const LOCK_PUBLISH_ATTEMPTS = 5
// A record that is being written is briefly empty or partial; give it this long.
const LOCK_UNREADABLE_GRACE_MS = 50
const LOCK_UNREADABLE_RETRIES = 10

/** Where the owner of a directory publishes its lease. */
export function managerLockRecordPath(lockPath: string): string {
  return join(dirname(lockPath), LOCK_RECORD)
}

export class ManagerLockHeldError extends Error {
  readonly code = 'MANAGER_LOCK_HELD'
  readonly pid: number

  constructor(owner: ManagerLockRecord) {
    super(`另一个插件实例正在管理本机设备（进程 ${owner.pid}）。请关闭该实例后重试。`)
    this.name = 'ManagerLockHeldError'
    this.pid = owner.pid
  }
}

/**
 * Ownership of a data directory. The owner listens on a loopback port the OS
 * picked and publishes `{port, pid, token}` in the directory; a contender
 * connects to that port and expects the token back. No port range is assumed,
 * so an excluded or reserved range can never refuse the lock (#144, #164); the
 * OS frees the port even after SIGKILL, so a dead owner's record is taken over
 * once the probe fails, never on the strength of a pid alone.
 *
 * Two contenders taking over the same dead record can both publish within a
 * few milliseconds of each other. The owner therefore re-reads its record
 * periodically and reports `onCompromised` if it was replaced, which bounds
 * that window to one interval.
 */
export async function acquireManagerLock(
  path: string, onCompromised?: () => void, options: { watchIntervalMs?: number } = {},
): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const record = managerLockRecordPath(path)
  const token = randomBytes(24).toString('base64url')
  // Not an HTTP/RPC endpoint: a connection only ever receives the token.
  const lease = createServer(socket => { socket.end(`${token}\n`) })
  await new Promise<void>((resolve, reject) => {
    lease.once('error', reject)
    lease.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      lease.off('error', reject)
      resolve()
    })
  })
  lease.unref()
  const closeLease = () => new Promise<void>((resolve, reject) => lease.close(error => error ? reject(error) : resolve()))
  const ours: ManagerLockRecord = {
    version: 1, port: (lease.address() as AddressInfo).port, pid: process.pid, token, startedAt: new Date().toISOString(),
  }
  try {
    await publishLockRecord(record, ours)
  } catch (error) {
    await closeLease().catch(() => undefined)
    throw error
  }
  let released = false
  const lost = () => { if (!released) onCompromised?.() }
  lease.on('error', lost)
  lease.on('close', lost)
  const watch = setInterval(() => {
    void readLockRecord(record).then(current => {
      if (!released && current !== 'unreadable' && current?.token !== token) lost()
    }, () => undefined)
  }, options.watchIntervalMs ?? LOCK_WATCH_INTERVAL_MS)
  watch.unref()
  return async () => {
    if (released) return
    released = true
    clearInterval(watch)
    if (lease.listening) await closeLease()
    const current = await readLockRecord(record).catch(() => null)
    if (current !== 'unreadable' && current?.token === token) await rm(record, { force: true })
  }
}

async function publishLockRecord(record: string, ours: ManagerLockRecord): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    if (!await createLockRecord(record, ours)) {
      const current = await readLockRecordSettled(record)
      if (current !== null && current !== 'unreadable' && current.token !== ours.token && await lockOwnerAlive(current)) {
        throw new ManagerLockHeldError(current)
      }
      // Absent (deleted meanwhile), unreadable for good, or a dead owner: take it over.
      await writeJson(record, ours)
    }
    const published = await readLockRecordSettled(record)
    if (published !== null && published !== 'unreadable' && published.token === ours.token) return
    if (published !== null && published !== 'unreadable' && await lockOwnerAlive(published)) throw new ManagerLockHeldError(published)
    if (attempt >= LOCK_PUBLISH_ATTEMPTS) throw new Error('无法登记本机管理记录，请稍后重试。')
  }
}

/** Exclusive creation: the first writer wins outright. */
async function createLockRecord(record: string, ours: ManagerLockRecord): Promise<boolean> {
  let file
  try {
    file = await open(record, 'wx', 0o600)
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return false
    throw error
  }
  try {
    await file.writeFile(`${JSON.stringify(ours, null, 2)}\n`)
    await file.sync()
  } finally { await file.close() }
  return true
}

async function readLockRecord(record: string): Promise<ManagerLockRecord | null | 'unreadable'> {
  let text: string
  try {
    text = await readFile(record, 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  }
  try {
    const value = JSON.parse(text) as Partial<ManagerLockRecord> | null
    if (value && value.version === 1 && Number.isInteger(value.port) && value.port! > 0 && value.port! < 65536
      && Number.isInteger(value.pid) && typeof value.token === 'string' && value.token.length > 0) {
      return value as ManagerLockRecord
    }
  } catch { /* partial or foreign content */ }
  return 'unreadable'
}

/** Like readLockRecord, but waits out a record that is still being written. */
async function readLockRecordSettled(record: string): Promise<ManagerLockRecord | null | 'unreadable'> {
  let current = await readLockRecord(record)
  for (let retry = 0; current === 'unreadable' && retry < LOCK_UNREADABLE_RETRIES; retry++) {
    await delay(LOCK_UNREADABLE_GRACE_MS)
    current = await readLockRecord(record)
  }
  return current
}

/** Whether the process named by a record still holds its lease: it must answer with the record's token. */
export function lockOwnerAlive(owner: ManagerLockRecord): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: owner.port })
    let received = ''
    let settled = false
    const done = (alive: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(alive)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(LOCK_PROBE_TIMEOUT_MS, () => done(false))
    socket.on('data', chunk => {
      received += chunk
      const newline = received.indexOf('\n')
      if (newline >= 0) done(received.slice(0, newline) === owner.token)
      else if (received.length > 512) done(false)
    })
    socket.on('end', () => done(received.trim() === owner.token))
    socket.on('error', () => done(false))
  })
}
