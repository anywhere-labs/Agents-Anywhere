// ported from Agents-Anywhere v2 desktop-workbench/electron/machine-state-lock.ts @98dd0e6e5 (withMachineStateLock, ownerAlive)
//
// The contracts/local-machine/2.0 short file transaction, so Desktop, the Python Connector and this Connector share
// one implementation of the lock (04-connector.md §9.1).
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { connect, createServer, type AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const SQLITE_BUSY = 5
const PROBE_TIMEOUT_MS = 200
const RETRY_INTERVAL_MS = 20
// A record that is being written is briefly empty or partial; give it this long.
const UNREADABLE_RETRIES = 5
const UNREADABLE_GRACE_MS = 10

export type MachineStateLockOptions = {
  timeoutMs?: number
  /** Receives one line when a dead writer's record is taken over. */
  warn?: (message: string) => void
}

export type MachineStateLockRecord = { version: 1; port: number; pid: number; token: string; startedAt: string }

/** Where the writer holding the record's transaction publishes its lease. */
export function machineStateLockRecordPath(filePath: string): string {
  return `${filePath}.lock.json`
}

/**
 * Short file transaction shared with Python: contracts/local-machine/2.0.
 *
 * A SQLite write transaction serializes updated writers across processes. The JSON lease
 * remains visible to older writers.
 *
 * The writer listens on a loopback port the OS picked and publishes
 * {port, pid, token} next to the record; a contender connects to that port and
 * expects the token back. No port range is assumed, so a Windows excluded range
 * can never refuse the lease; the OS frees the port even after a crash, so a
 * dead writer's record is taken over once the probe fails.
 */
export async function withMachineStateLock<T>(
  filePath: string,
  update: () => T | Promise<T>,
  { timeoutMs = 5_000, warn }: MachineStateLockOptions = {},
): Promise<T> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const record = machineStateLockRecordPath(filePath)
  const token = randomBytes(18).toString('base64url')
  // A connection only ever receives the token; this is not an RPC endpoint.
  const lease = createServer(socket => { socket.end(`${token}\n`); })
  await new Promise<void>((resolve, reject) => {
    lease.once('error', reject)
    lease.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      lease.off('error', reject)
      resolve()
    })
  })
  const ours: MachineStateLockRecord = {
    version: 1, port: (lease.address() as AddressInfo).port, pid: process.pid, token, startedAt: new Date().toISOString(),
  }
  const deadline = Date.now() + timeoutMs
  const busy = () => new Error('The local machine record is busy. Please retry.')
  let guard: DatabaseSync | undefined
  try {
    guard = await acquireGuard(filePath, deadline, busy)
    for (;;) {
      if (!(await createRecord(record, ours))) {
        const current = await readRecordSettled(record)
        if (current === null || (current !== 'unreadable' && current.token !== token && (await ownerAlive(current)))) {
          if (Date.now() >= deadline) throw busy()
          await delay(RETRY_INTERVAL_MS)
          continue
        }
        // Only a record that was read and found unusable needs takeover.
        if (current !== null && current !== 'unreadable') warn?.(`Stale local machine record lock taken over (pid ${current.pid}).`)
        await replaceRecord(record, ours)
      }
      const published = await readRecordSettled(record)
      if (published !== null && published !== 'unreadable' && published.token === token) break
      if (published !== null && published !== 'unreadable' && (await ownerAlive(published))) {
        if (Date.now() >= deadline) throw busy()
        await delay(RETRY_INTERVAL_MS)
      }
      // Otherwise another contender's dead record won the race; take over again.
    }
    try {
      return await update()
    } finally {
      const current = await readRecord(record).catch(() => null)
      if (current !== null && current !== 'unreadable' && current.token === token) await rm(record, { force: true })
    }
  } finally {
    try {
      guard?.close()
    } finally {
      await new Promise<void>(resolve => lease.close(() => resolve()))
    }
  }
}

/** Keep the same inode across transactions so SQLite can coordinate every writer. */
async function acquireGuard(filePath: string, deadline: number, busy: () => Error): Promise<DatabaseSync> {
  const guardPath = `${filePath}.lock.sqlite`
  try {
    const file = await open(guardPath, 'wx', 0o600)
    await file.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const db = new DatabaseSync(guardPath)
  try {
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE')
        return db
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== SQLITE_BUSY) throw error
        if (Date.now() >= deadline) throw busy()
        await delay(RETRY_INTERVAL_MS)
      }
    }
  } catch (error) {
    db.close()
    throw error
  }
}

/** Exclusive creation: the first writer wins outright. */
async function createRecord(record: string, ours: MachineStateLockRecord): Promise<boolean> {
  let file
  try {
    file = await open(record, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    await file.writeFile(`${JSON.stringify(ours, null, 2)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
  return true
}

async function replaceRecord(record: string, ours: MachineStateLockRecord): Promise<void> {
  const temporary = `${record}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(`${JSON.stringify(ours, null, 2)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, record)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function readRecord(record: string): Promise<MachineStateLockRecord | null | 'unreadable'> {
  let text: string
  try {
    text = await readFile(record, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const value = JSON.parse(text) as Partial<MachineStateLockRecord> | null
    if (value && value.version === 1 && Number.isInteger(value.port) && value.port! > 0 && value.port! < 65536
      && Number.isInteger(value.pid) && typeof value.token === 'string' && value.token.length > 0) {
      return value as MachineStateLockRecord
    }
  } catch {
    // partial or foreign content
  }
  return 'unreadable'
}

async function readRecordSettled(record: string): Promise<MachineStateLockRecord | null | 'unreadable'> {
  let current = await readRecord(record)
  for (let retry = 0; current === 'unreadable' && retry < UNREADABLE_RETRIES; retry++) {
    await delay(UNREADABLE_GRACE_MS)
    current = await readRecord(record)
  }
  return current
}

/** Whether the writer named by a record still holds its lease: it must answer with the token. */
export function ownerAlive(owner: MachineStateLockRecord): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    let received = ''
    const socket = connect({ host: '127.0.0.1', port: owner.port })
    const done = (alive: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(alive)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false))
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
