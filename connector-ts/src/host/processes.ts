// ported from effi-crew cloud/agentd/src/single.ts @30f8334 (commandLine)
// ported from Agents-Anywhere v2 connector/connector/core/runtime_owner.py @98dd0e6e5 (start-time identity)
//
// Process liveness for the runtime record (contracts/local-machine/2.0): pid, start time and command line.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface ProcessProbe {
  /** Whether a process with this pid exists (EPERM counts: it exists, owned by someone else). */
  exists(pid: number): boolean
  /** Start time in whole seconds since the epoch; null when the process is gone or cannot be inspected. */
  startedAt(pid: number): Promise<number | null>
  /** The command line; null when the process is gone or cannot be inspected. */
  commandLine(pid: number): Promise<string | null>
}

/** The legacy identity for one start time (`ps -o lstart=` in UTC), which the 2.x Python Connector can verify. */
export function legacyIdentity(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()]!
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]!
  const time = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].map(n => String(n).padStart(2, '0')).join(':')
  return `${day} ${month} ${date.getUTCDate()} ${time} ${date.getUTCFullYear()}`
}

/** Parses `ps -o lstart=` output (LC_ALL=C, TZ=UTC) to epoch seconds. */
export function parseLstart(text: string): number | null {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u.exec(text.trim().replace(/\s+/gu, ' '))
  if (m === null) return null
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[1]!)
  if (month < 0) return null
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000
}

/** Windows `StartTime.ToUniversalTime().Ticks` (100 ns since 0001-01-01) to epoch seconds. */
export function ticksToEpoch(ticks: string): number | null {
  if (!/^\d+$/u.test(ticks.trim())) return null
  return Math.floor((Number(BigInt(ticks.trim()) - 621355968000000000n) / 1e7))
}

/** Whether a recorded identity (2.x `unix:<float>`, the legacy `ps` text, or Windows ticks) names this start time. */
export function identityMatches(identity: string, startedAt: number): boolean {
  if (identity.startsWith('unix:')) {
    const seconds = Number(identity.slice(5))
    return Number.isFinite(seconds) && Math.abs(Math.floor(seconds) - startedAt) <= 1
  }
  const lstart = parseLstart(identity)
  if (lstart !== null) return Math.abs(lstart - startedAt) <= 1
  const ticks = ticksToEpoch(identity)
  return ticks !== null && Math.abs(ticks - startedAt) <= 1
}

/** A digest of a command line, recorded so a reused pid running something else is not taken for the owner. */
export function commandDigest(commandLine: string): string {
  return `sha256:${createHash('sha256').update(commandLine.trim().replace(/\s+/gu, ' ')).digest('hex')}`
}

/**
 * Entry points of the 2.x Python Connector (`anywhere-cli`, `agent-connector`, `python -m connector.cli`): a 2.x
 * owner is recognised only by its command line, the same check the 2.x Connector applies.
 */
export function isV2ConnectorCommand(commandLine: string): boolean {
  const parts = commandLine.trim().split(/\s+/u)
  const exe = basename((parts[0] ?? '').replace(/\\/gu, '/')).toLowerCase()
  if (['anywhere-cli', 'agent-connector', 'anywhere-cli.exe', 'agent-connector.exe'].includes(exe)) return true
  if (!exe.startsWith('python') && !exe.startsWith('pypy')) return false
  const text = parts.slice(1).join(' ').replace(/\\/gu, '/')
  return /(^|\s)-m\s+connector(\.cli)?(\s|$)/u.test(text) || /(^|\/)(anywhere-cli|agent-connector)(\.exe)?(\s|$)/iu.test(text) || /\/connector\/cli\.py(\s|$)/u.test(text)
}

export const systemProbe: ProcessProbe = {
  exists(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  async startedAt(pid) {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout: 5000, windowsHide: true })
        return ticksToEpoch(stdout)
      }
      const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })
      return parseLstart(stdout)
    } catch {
      return null
    }
  },
  async commandLine(pid) {
    try {
      if (process.platform === 'linux') return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(part => part !== '').join(' ')
      if (process.platform === 'win32') {
        const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 8000, windowsHide: true })
        return stdout.trim() === '' ? null : stdout.trim()
      }
      const { stdout } = await run('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 })
      return stdout.trim() === '' ? null : stdout.trim()
    } catch {
      return null
    }
  },
}
