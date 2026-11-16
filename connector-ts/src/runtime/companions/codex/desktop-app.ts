// 找到 Codex App 的主进程，并结束它。
// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/ipc/desktop_app.py
//
// macOS 上 Codex App 在 ChatGPT.app 里（也有单独的 Codex.app）。主进程持有 IPC 窗口和 app-server，
// app-server 持有线程写锁，所以主进程退出就会释放 App 加载过的所有线程。macOS / Linux 上辅助进程是
// 主进程的子进程，随它退出；Windows 上不会，所以那里要结束整棵进程树。
//
// 与 v2 的差别：
// - 进程表带「身份」（PID + 启动时间 + 可执行文件 + 用户），复核时防 PID 复用（session-ownership.md 第 4 步）；
// - 只认当前用户的进程；
// - 进程表和信号都可注入，单测不碰真实进程；结束的时机和确认流程在 quit-app.ts。

import { execFile } from 'node:child_process'

const PROBE_TIMEOUT_MS = 5_000

/** 各平台主进程可执行文件路径的结尾。 */
export const DESKTOP_PROCESS_MARKERS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['/ChatGPT.app/Contents/MacOS/ChatGPT', '/Codex.app/Contents/MacOS/Codex'],
  linux: ['/chatgpt', '/codex-desktop', '/Codex'],
}

/** Windows：Codex 包（WindowsApps 下的 OpenAI.Codex_*）里的 ChatGPT.exe。 */
const WINDOWS_PACKAGE_MARKER = '\\windowsapps\\openai.codex_'
const WINDOWS_EXECUTABLE = 'chatgpt.exe'

export interface ProcessInfo {
  readonly pid: number
  readonly ppid: number
  /** 平台给出的启动时间文本（ps lstart / Win32 CreationDate），与 PID 一起作为身份。 */
  readonly startedAt: string
  readonly executable: string
  /** POSIX 用户 ID；Windows 上没有。 */
  readonly uid?: number
}

export interface ProcessTable {
  /** 当前进程表；读不到时返回 undefined（不当作「没有 App」）。 */
  list(): Promise<readonly ProcessInfo[] | undefined>
}

export interface ProcessSignaller {
  /** 请求有序退出：POSIX SIGTERM；Windows 结束整棵树（不加 /F）。 */
  terminate(process: ProcessInfo): Promise<void>
  /** 强制结束：POSIX SIGKILL；Windows taskkill /T /F。 */
  kill(process: ProcessInfo): Promise<void>
}

export function quitSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || DESKTOP_PROCESS_MARKERS[platform] !== undefined
}

export function processKey(process: ProcessInfo): string {
  return `${process.pid}\u0000${process.startedAt}\u0000${process.executable}\u0000${process.uid ?? ''}`
}

/** Codex App 主进程（不含辅助进程）。uid 给出时只认这个用户的进程。 */
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

/** 某个进程的全部后代（按 ppid）。 */
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

/** 解析 `ps -axo pid=,ppid=,uid=,lstart=,comm=`：lstart 固定五段（例如 `Mon Nov 16 18:19:54 2026`）。 */
export function parsePsListing(listing: string): ProcessInfo[] {
  const result: ProcessInfo[] = []
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    result.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), startedAt: match[4]!.replace(/\s+/g, ' '), executable: match[5]! })
  }
  return result
}

/** 解析 PowerShell `ConvertTo-Json` 输出的 Win32_Process（一条时是对象，多条时是数组）。 */
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

/** 系统进程表。Linux 用 args 的第一段当可执行文件（comm 被截断成 15 个字符）；Linux 上没有实测过。 */
export function systemProcessTable(platform: NodeJS.Platform = process.platform, timeoutMs = PROBE_TIMEOUT_MS): ProcessTable {
  return {
    async list() {
      if (platform === 'win32') {
        // 先按名字过滤：枚举全部进程再取父进程很慢（v2 实测几十秒）。
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
    // Windows 没有 SIGTERM；taskkill 不带 /F 时向窗口发关闭请求，/T 带上子进程（app-server 是 ChatGPT.exe 的子进程）。
    return {
      terminate: async p => { await run('taskkill.exe', ['/PID', String(p.pid), '/T'], PROBE_TIMEOUT_MS) },
      kill: async p => { await run('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], PROBE_TIMEOUT_MS) },
    }
  }
  const send = (p: ProcessInfo, signal: NodeJS.Signals) => {
    try {
      process.kill(p.pid, signal)
    } catch {
      // 已经退出，或没有权限；退出与否由复核进程表判断。
    }
  }
  return {
    terminate: async p => send(p, 'SIGTERM'),
    kill: async p => send(p, 'SIGKILL'),
  }
}

/** 当前用户的 uid；Windows 上没有。 */
export function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}
