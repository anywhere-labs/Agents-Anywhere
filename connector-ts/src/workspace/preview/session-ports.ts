// Associates listening ports with sessions (09-port-preview.md §5.1): a port belongs to a session when its process
// descends from that session's Agent or terminal process; URLs in tool and terminal output are a fallback signal.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { ListeningPort } from '../ports.js'

const run = promisify(execFile)

/** pid → parent pid. */
export type ProcessParents = ReadonlyMap<number, number>

/** `ps -A -o pid=,ppid=` (macOS, Linux) → pid → parent pid. */
export function parsePs(text: string): Map<number, number> {
  const parents = new Map<number, number>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line)
    if (m !== null) parents.set(Number(m[1]), Number(m[2]))
  }
  return parents
}

/** `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }` → pid → parent pid. */
export const parseWindowsProcesses = parsePs

/** This machine's process tree; empty when it cannot be read. */
export async function processParents(platform: NodeJS.Platform = process.platform): Promise<Map<number, number>> {
  try {
    if (platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
      return parseWindowsProcesses(stdout)
    }
    const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    return parsePs(stdout)
  } catch {
    return new Map()
  }
}

/** The session whose root process is `pid` or one of its ancestors. */
export function sessionOfProcess(pid: number | null, roots: ReadonlyMap<number, string>, parents: ProcessParents): string | null {
  const seen = new Set<number>()
  let current = pid
  while (current !== null && current > 1 && !seen.has(current)) {
    const session = roots.get(current)
    if (session !== undefined) return session
    seen.add(current)
    current = parents.get(current) ?? null
  }
  return null
}

const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(?:[/?#][^\s'"<>)]*)?/giu

/** Local URLs printed by a tool or terminal (`http://localhost:5173/`), by port. */
export function localUrlsIn(text: string): Map<number, string> {
  const urls = new Map<number, string>()
  for (const m of text.matchAll(LOCAL_URL)) {
    const port = Number(m[1])
    if (port > 0 && port <= 65535 && !urls.has(port)) urls.set(port, m[0].replace(/[.,;:]+$/u, ''))
  }
  return urls
}

/** The wire shape of one port in `port.listening` (preview 1.0 `ListeningPort`). */
export interface AnnotatedPort {
  readonly port: number
  readonly pid: number | null
  readonly processName: string | null
  readonly sessionId: string | null
  readonly url: string | null
}

export interface SessionHints {
  /** Root process ids of each session's Agent and AA terminals. */
  readonly roots: ReadonlyMap<number, string>
  /** URLs seen in a session's output, by port; used when the process tree does not decide. */
  readonly mentioned: ReadonlyMap<number, { sessionId: string; url: string }>
}

export function annotatePorts(ports: readonly ListeningPort[], hints: SessionHints, parents: ProcessParents): AnnotatedPort[] {
  return ports.map(port => {
    const mention = hints.mentioned.get(port.port)
    const sessionId = sessionOfProcess(port.pid, hints.roots, parents) ?? mention?.sessionId ?? null
    return {
      port: port.port,
      pid: port.pid,
      processName: port.process === '' ? null : port.process,
      sessionId,
      url: mention?.url ?? `http://localhost:${port.port}`,
    }
  })
}
