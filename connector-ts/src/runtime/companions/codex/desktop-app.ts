// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/ipc/desktop_app.py @98dd0e6e5 (desktop app process)
//
// Finds the Codex App main process and ends it.
//
// On macOS the Codex App lives inside ChatGPT.app (there is also a standalone Codex.app). The main process holds the
// IPC window and the app-server, and the app-server holds the thread write locks, so the main process exiting
// releases every thread the App loaded. On macOS / Linux the helper processes are children of the main process and
// exit with it; on Windows they do not, so the whole process tree is ended there.
//
// - The process table carries an identity (PID + start time + executable + user), so a recheck guards against PID
//   reuse (session-ownership.md step 4);
// - only processes of the current user are considered;
// - the process table and signals are injectable, so unit tests never touch real processes; when to end the App and
//   how it is confirmed live in quit-app.ts.

import { execFile } from 'node:child_process'

const PROBE_TIMEOUT_MS = 5_000

/** Suffix of the main process executable path per platform. */
export const DESKTOP_PROCESS_MARKERS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['/ChatGPT.app/Contents/MacOS/ChatGPT', '/Codex.app/Contents/MacOS/Codex'],
  linux: ['/chatgpt', '/codex-desktop', '/Codex'],
}

/** Windows: ChatGPT.exe in the Codex package (OpenAI.Codex_* under WindowsApps). */
const WINDOWS_PACKAGE_MARKER = '\\windowsapps\\openai.codex_'
const WINDOWS_EXECUTABLE = 'chatgpt.exe'

export interface ProcessInfo {
  readonly pid: number
  readonly ppid: number
  /** Start time text from the platform (ps lstart / Win32 CreationDate); together with the PID it forms the identity. */
  readonly startedAt: string
  readonly executable: string
  /** POSIX user ID; absent on Windows. */
  readonly uid?: number
}

export interface ProcessTable {
  /** The current process table; undefined when it cannot be read (not treated as "no App"). */
  list(): Promise<readonly ProcessInfo[] | undefined>
}

export interface ProcessSignaller {
  /** Requests an orderly exit: SIGTERM on POSIX; on Windows ends the whole tree (without /F). */
  terminate(process: ProcessInfo): Promise<void>
  /** Forces the end: SIGKILL on POSIX; taskkill /T /F on Windows. */
  kill(process: ProcessInfo): Promise<void>
}

export function quitSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || DESKTOP_PROCESS_MARKERS[platform] !== undefined
}

export function processKey(process: ProcessInfo): string {
  return `${process.pid}\u0000${process.startedAt}\u0000${process.executable}\u0000${process.uid ?? ''}`
}

/** Codex App main processes (helpers excluded). When uid is given, only that user's processes count. */
export function desktopAppProcesses(table: readonly ProcessInfo[], platform: NodeJS.Platform, uid?: number): ProcessInfo[] {
  const mine = (p: ProcessInfo) => uid === undefined || p.uid === undefined || p.uid === uid
  if (platform === 'win32') {
    const candidates = table.filter(p => mine(p)
      && p.executable.toLowerCase().endsWith(`\\${WINDOWS_EXECUTABLE}`)
      && p.executable.toLowerCase().includes(WINDOWS_PACKAGE_MARKER))
    const pids = new Set(candidates.map(p => p.pid))
    return candidates.filter(p => !pids.has(p.ppid))
  }
  const markers = DESKTOP_PROCESS_MARKERS[platform] ?? []
  return table.filter(p => mine(p) && markers.some(marker => p.executable.endsWith(marker)))
}

/** All descendants of a process (by ppid). */
export function descendants(table: readonly ProcessInfo[], root: ProcessInfo): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>()
  for (const p of table) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  const result: ProcessInfo[] = []
  const queue = [root.pid]
  const seen = new Set(queue)
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      result.push(child)
      queue.push(child.pid)
    }
  }
  return result
}

/** Parses `ps -axo pid=,ppid=,uid=,lstart=,comm=`: lstart always has five fields (e.g. `Mon Nov 16 18:19:54 2026`). */
export function parsePsListing(listing: string): ProcessInfo[] {
  const result: ProcessInfo[] = []
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    result.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), startedAt: match[4]!.replace(/\s+/g, ' '), executable: match[5]! })
  }
  return result
}

/** Parses Win32_Process from PowerShell `ConvertTo-Json` output (an object for one entry, an array for several). */
export function parseWindowsListing(json: string): ProcessInfo[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json || '[]')
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const result: ProcessInfo[] = []
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>
    if (typeof r.ProcessId !== 'number' || typeof r.ExecutablePath !== 'string') continue
    result.push({ pid: r.ProcessId, ppid: typeof r.ParentProcessId === 'number' ? r.ParentProcessId : 0, startedAt: String(r.CreationDate ?? ''), executable: r.ExecutablePath })
  }
  return result
}

function run(command: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout))
  })
}

/** The system process table. On Linux the first field of args is the executable (comm is truncated to 15 characters); untested on Linux. */
export function systemProcessTable(platform: NodeJS.Platform = process.platform, timeoutMs = PROBE_TIMEOUT_MS): ProcessTable {
  return {
    async list() {
      if (platform === 'win32') {
        // Filter by name first: enumerating every process and then fetching parents takes tens of seconds.
        const script = "Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' OR Name='codex.exe'\" | "
          + "Select-Object ProcessId,ParentProcessId,@{n='CreationDate';e={$_.CreationDate.ToString('o')}},ExecutablePath | ConvertTo-Json -Compress"
        const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs)
        return out === undefined ? undefined : parseWindowsListing(out.trim())
      }
      const out = await run('ps', ['-axo', `pid=,ppid=,uid=,lstart=,${platform === 'linux' ? 'args' : 'comm'}=`], timeoutMs)
      if (out === undefined) return undefined
      const table = parsePsListing(out)
      return platform === 'linux' ? table.map(p => ({ ...p, executable: p.executable.split(' ')[0] ?? p.executable })) : table
    },
  }
}

export function systemSignaller(platform: NodeJS.Platform = process.platform): ProcessSignaller {
  if (platform === 'win32') {
    // Windows has no SIGTERM; taskkill without /F sends a close request to the windows, and /T includes children (the app-server is a child of ChatGPT.exe).
    return {
      terminate: async p => { await run('taskkill.exe', ['/PID', String(p.pid), '/T'], PROBE_TIMEOUT_MS) },
      kill: async p => { await run('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], PROBE_TIMEOUT_MS) },
    }
  }
  const send = (p: ProcessInfo, signal: NodeJS.Signals) => {
    try {
      process.kill(p.pid, signal)
    } catch {
      // Already exited, or no permission; whether it exited is decided by rechecking the process table.
    }
  }
  return {
    terminate: async p => send(p, 'SIGTERM'),
    kill: async p => send(p, 'SIGKILL'),
  }
}

/** The current user's uid; absent on Windows. */
export function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}
