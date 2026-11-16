// ported from effi-crew cloud/agentd/src/ports.ts @30f8334: listening TCP ports from /proc/net/tcp{,6} on Linux,
// `lsof` on macOS and BSD, `netstat` + `tasklist` on Windows. v3 drops the container assumptions (openvscode-server,
// Docker's embedded DNS), runs the tools asynchronously so the event loop never blocks, and adds the pid and a
// watcher for the `port.listening` / `port.closed` events (09-port-preview.md).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir, readlink } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface ListenSocket {
  readonly port: number
  readonly address: string
  readonly inode: string
}

export interface ListeningPort {
  readonly port: number
  readonly address: string
  readonly pid: number | null
  readonly process: string
}

function hexToIpv4(hex: string): string {
  // Little-endian per 32-bit word.
  return [0, 1, 2, 3].map(i => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).reverse().join('.')
}

function hexToIpv6(hex: string): string {
  if (/^0+$/u.test(hex)) return '::'
  if (hex === '00000000000000000000000001000000') return '::1'
  // IPv4-mapped (::ffff:a.b.c.d): words 0-1 zero, word 2 = 0000FFFF (LE: FFFF0000).
  if (hex.slice(0, 16) === '0000000000000000' && hex.slice(16, 24).toUpperCase() === 'FFFF0000') return '::ffff:' + hexToIpv4(hex.slice(24, 32))
  const words: string[] = []
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8)
    const bytes = [0, 1, 2, 3].map(i => word.slice(i * 2, i * 2 + 2)).reverse().join('')
    words.push(bytes.slice(0, 4), bytes.slice(4, 8))
  }
  return words.map(g => g.replace(/^0+(?=.)/u, '').toLowerCase()).join(':')
}

/** Parse the text of /proc/net/tcp or /proc/net/tcp6; LISTEN (state 0A) sockets only. */
export function parseProcNetTcp(text: string, v6: boolean): ListenSocket[] {
  const out: ListenSocket[] = []
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/u)
    if (cols.length < 10) continue
    if (cols[3] !== '0A') continue
    const [addrHex = '', portHex = '0'] = cols[1]!.split(':')
    out.push({ port: parseInt(portHex, 16), address: v6 ? hexToIpv6(addrHex) : hexToIpv4(addrHex), inode: cols[9]! })
  }
  return out
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output → listening sockets with their process. */
export function parseLsof(text: string): ListeningPort[] {
  const out: ListeningPort[] = []
  let pid = 0
  let cmd = ''
  for (const line of text.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') pid = Number(value)
    else if (tag === 'c') cmd = value
    else if (tag === 'n') {
      const m = /^(.*):(\d+)$/u.exec(value)
      if (m === null) continue
      const address = m[1] === '*' ? '0.0.0.0' : m[1]!.replace(/^\[|\]$/gu, '')
      out.push({ port: Number(m[2]), address, pid, process: cmd })
    }
  }
  return out
}

/** `netstat -ano -p TCP` (Windows) → LISTENING sockets with the owning pid. */
export function parseNetstat(text: string): { port: number; address: string; pid: number }[] {
  const out: { port: number; address: string; pid: number }[] = []
  for (const line of text.split(/\r?\n/u)) {
    const cols = line.trim().split(/\s+/u)
    if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue
    const m = /^(.*):(\d+)$/u.exec(cols[1]!)
    if (m === null) continue
    out.push({ port: Number(m[2]), address: m[1]!.replace(/^\[|\]$/gu, ''), pid: Number(cols[4]) })
  }
  return out
}

/** `tasklist /FO CSV /NH` → pid → image name. */
export function parseTasklist(text: string): Map<number, string> {
  const names = new Map<number, string>()
  for (const line of text.split(/\r?\n/u)) {
    const m = /^"([^"]*)","(\d+)"/u.exec(line)
    if (m !== null) names.set(Number(m[2]), m[1]!)
  }
  return names
}

/** inode → owning process, for sockets of processes we may inspect (our own user's). */
async function socketOwners(): Promise<Map<string, { pid: number; name: string }>> {
  const owners = new Map<string, { pid: number; name: string }>()
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter(p => /^\d+$/u.test(p))
  for (const pid of pids) {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => undefined)
    if (fds === undefined) continue
    let name: string | undefined
    for (const fd of fds) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => undefined)
      const m = target === undefined ? null : /^socket:\[(\d+)\]$/u.exec(target)
      if (m === null) continue
      if (name === undefined) {
        try {
          const cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(s => s !== '')
          name = cmdline.length > 0 ? cmdline.slice(0, 3).join(' ').slice(0, 120) : (await readFile(`/proc/${pid}/comm`, 'utf8')).trim()
        } catch {
          name = '?'
        }
      }
      owners.set(m[1]!, { pid: Number(pid), name })
    }
  }
  return owners
}

async function portsFromTools(platform: NodeJS.Platform): Promise<ListeningPort[]> {
  try {
    if (platform === 'win32') {
      const [netstat, tasklist] = await Promise.all([
        run('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, windowsHide: true }),
        run('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true }),
      ])
      const names = parseTasklist(tasklist.stdout)
      return parseNetstat(netstat.stdout).map(s => ({ ...s, process: names.get(s.pid) ?? '' }))
    }
    const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { encoding: 'utf8', timeout: 5000 })
    return parseLsof(stdout)
  } catch (error) {
    // lsof exits 1 when nothing is listening.
    const stdout = (error as { stdout?: unknown }).stdout
    return platform !== 'win32' && typeof stdout === 'string' ? parseLsof(stdout) : []
  }
}

const wildcard = (address: string): boolean => address === '0.0.0.0' || address === '::'

/** One entry per port: the wildcard binding wins (reachable from every interface), then one with a known process. */
export function mergeByPort(sockets: Iterable<ListeningPort>, exclude: ReadonlySet<number>, ownPid: number): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>()
  for (const s of sockets) {
    if (exclude.has(s.port) || s.pid === ownPid) continue
    const prev = byPort.get(s.port)
    if (prev === undefined || (!wildcard(prev.address) && wildcard(s.address)) || (prev.process === '' && s.process !== '')) {
      byPort.set(s.port, { ...s, process: s.process !== '' ? s.process : prev?.process ?? '' })
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}

/** Listening ports of this machine, without `exclude`d ports and the Connector's own sockets. */
export async function listeningPorts(exclude: ReadonlySet<number> = new Set(), platform: NodeJS.Platform = process.platform): Promise<ListeningPort[]> {
  if (platform !== 'linux' || !existsSync('/proc/net/tcp')) return mergeByPort(await portsFromTools(platform), exclude, process.pid)
  const sockets: ListenSocket[] = []
  for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]] as const) {
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text !== undefined) sockets.push(...parseProcNetTcp(text, v6))
  }
  const owners = sockets.length > 0 ? await socketOwners() : new Map<string, { pid: number; name: string }>()
  return mergeByPort(sockets.map(s => {
    const owner = owners.get(s.inode)
    return { port: s.port, address: s.address, pid: owner?.pid ?? null, process: owner?.name ?? '' }
  }), exclude, process.pid)
}

export interface PortWatcherOptions {
  readonly list?: () => Promise<ListeningPort[]>
  readonly intervalMs?: number
  /** `port.listening` with the full current list whenever it changes; `port.closed` for each port that went away. */
  readonly emit: (method: 'port.listening' | 'port.closed', payload: Record<string, unknown>) => void
  readonly deviceId: string
}

/**
 * Polls the listening ports (default every 5 s) and reports changes as `Link/attach` events. `current()` is the
 * last list, for a fresh attach stream.
 */
export class PortWatcher {
  private known = new Map<number, ListeningPort>()
  private timer: NodeJS.Timeout | undefined
  private polling: Promise<void> | undefined

  public constructor(private readonly options: PortWatcherOptions) {}

  public start(): void {
    if (this.timer !== undefined) return
    void this.poll()
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? 5000)
    this.timer.unref()
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  public current(): Record<string, unknown> {
    return { deviceId: this.options.deviceId, ports: [...this.known.values()].map(wirePort) }
  }

  /** One poll; overlapping calls share the running one. */
  public poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = undefined
    })
    return this.polling
  }

  private async pollOnce(): Promise<void> {
    let ports: ListeningPort[]
    try {
      ports = await (this.options.list ?? listeningPorts)()
    } catch {
      return
    }
    const next = new Map(ports.map(port => [port.port, port]))
    let changed = next.size !== this.known.size
    for (const [port, entry] of next) {
      const prev = this.known.get(port)
      if (prev === undefined || prev.pid !== entry.pid || prev.process !== entry.process) changed = true
    }
    const closed = [...this.known.keys()].filter(port => !next.has(port))
    this.known = next
    for (const port of closed) this.options.emit('port.closed', { deviceId: this.options.deviceId, port })
    if (changed && next.size > 0) this.options.emit('port.listening', this.current())
  }
}

function wirePort(port: ListeningPort): Record<string, unknown> {
  return { port: port.port, pid: port.pid, processName: port.process === '' ? null : port.process }
}
