import { execFile } from 'node:child_process'
import { readFile, readdir, readlink } from 'node:fs/promises'
import { basename, win32 } from 'node:path'
import { promisify } from 'node:util'
import { hasCode } from '../storage/files.js'

const run = promisify(execFile)
/** How long an identified main process is trusted by its PID alone before its image name is checked again. */
const WINDOWS_REVERIFY_MS = 60_000
/** A process the full query could not read may just be starting; it may also belong to another user. */
const WINDOWS_UNREADABLE_RETRY_MS = 5_000
const HELPER_ARGUMENT = /(?:^|\s)--type(?:=|\s)/
const BACKEND_ARGUMENT = /[\\/]backend[\\/]index\.js(?=["'\s]|$)/i

export interface DesktopProcessTarget {
  executablePath: string
  launchArgs: string[]
  packaged: boolean
}

export interface DesktopProcessCandidate {
  pid?: number
  executablePath?: string
  commandLine: string
  appImagePath?: string
  appDir?: string
  electronRunAsNode?: boolean
}

function samePath(left: string, right: string, platform: string): boolean {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function hasArgument(commandLine: string, argument: string, platform: string): boolean {
  const line = platform === 'win32' ? commandLine.toLowerCase() : commandLine
  const value = platform === 'win32' ? argument.toLowerCase() : argument
  return [value, `"${value}"`, `'${value}'`].some(token => {
    let offset = line.indexOf(token)
    while (offset !== -1) {
      if ((offset === 0 || /\s/.test(line[offset - 1]!)) &&
          (offset + token.length === line.length || /\s/.test(line[offset + token.length]!))) return true
      offset = line.indexOf(token, offset + 1)
    }
    return false
  })
}

function isBundledDevExecutable(executablePath: string, appPath: string, platform: string): boolean {
  const exe = (platform === 'win32' ? executablePath.toLowerCase() : executablePath).replaceAll('\\', '/')
  const root = (platform === 'win32' ? appPath.toLowerCase() : appPath).replaceAll('\\', '/').replace(/\/+$/, '')
  return Boolean(root) && exe.startsWith(`${root}/node_modules/`)
}

function matchesLaunchArgument(target: DesktopProcessTarget, commandLine: string, argument: string, platform: string): boolean {
  if (hasArgument(commandLine, argument, platform)) return true
  return isBundledDevExecutable(target.executablePath, argument, platform) && hasArgument(commandLine, '.', platform)
}

/** Never confuse Electron renderer/GPU helpers or another development Electron app with Main. */
export function matchesDesktopProcess(target: DesktopProcessTarget, candidate: DesktopProcessCandidate, platform: string): boolean {
  const executableMatches = candidate.executablePath !== undefined && samePath(candidate.executablePath, target.executablePath, platform)
  const appImageMatches = platform === 'linux' && target.packaged && candidate.appImagePath !== undefined &&
    samePath(candidate.appImagePath, target.executablePath, platform) && candidate.appDir !== undefined &&
    candidate.executablePath?.startsWith(`${candidate.appDir}/`)
  if (!executableMatches && !appImageMatches) return false
  if (HELPER_ARGUMENT.test(candidate.commandLine) || BACKEND_ARGUMENT.test(candidate.commandLine) || candidate.electronRunAsNode) return false
  return target.packaged || target.launchArgs.every(argument => matchesLaunchArgument(target, candidate.commandLine, argument, platform))
}

async function macProcesses(): Promise<DesktopProcessCandidate[]> {
  const { stdout } = await run('/bin/ps', ['-axo', 'command=', '-ww'], { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 })
  // ps has no argv array. The leading executable is the recorded absolute path;
  // matching it with an argument boundary also supports paths containing spaces.
  return stdout.split('\n').filter(Boolean).map(commandLine => ({ commandLine }))
}

async function windowsProcesses(imageName: string): Promise<DesktopProcessCandidate[]> {
  const name = imageName.replaceAll("'", "''")
  // A denied or unavailable CIM query also prints nothing; Stop makes it exit non-zero
  // instead, so an empty result can only mean that no process matched. The encoding line stays non-fatal.
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process -Filter "Name = '${name}'" | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    timeout: 5_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  })
  return parseWindowsProcesses(stdout)
}

/** ConvertTo-Json receives no input when no process matches and prints nothing, not `[]`. */
export function parseWindowsProcesses(stdout: string): DesktopProcessCandidate[] {
  const output = stdout.replace(/^\uFEFF/, '').trim()
  if (!output) return []
  const result: unknown = JSON.parse(output)
  const entries = Array.isArray(result) ? result : result ? [result] : []
  return entries.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as Record<string, unknown>
    return typeof value.ExecutablePath === 'string' && typeof value.CommandLine === 'string'
      ? [{ ...(typeof value.ProcessId === 'number' ? { pid: value.ProcessId } : {}), executablePath: value.ExecutablePath, commandLine: value.CommandLine }] : []
  })
}

async function windowsImagePids(imageName: string): Promise<number[]> {
  const tasklist = win32.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'tasklist.exe')
  const { stdout, stderr } = await run(tasklist, ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${imageName}`], {
    timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024,
  })
  return parseTasklistPids(stdout, stderr)
}

/**
 * Matches are quoted CSV rows on stdout. The notice printed when nothing matches is
 * localized, so only its shape tells it apart; no output at all is not an answer.
 */
export function parseTasklistPids(stdout: string, stderr = ''): number[] {
  if (!stdout.trim() && !stderr.trim()) throw new Error('tasklist printed nothing.')
  return stdout.split(/\r?\n/).flatMap(line => {
    const pid = /^"[^"]*","(\d+)"/.exec(line.trim())?.[1]
    return pid ? [Number(pid)] : []
  })
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return hasCode(error, 'EPERM') }
}

export interface WindowsProcessQueries {
  /** PIDs running an image: cheap enough for every poll, but blind to what each one is. */
  imagePids(imageName: string): Promise<number[]>
  /** The PowerShell query: expensive, and the only one that can tell Main from its helpers. */
  candidates(imageName: string): Promise<DesktopProcessCandidate[]>
  alive(pid: number): boolean
}

const systemWindowsQueries: WindowsProcessQueries = { imagePids: windowsImagePids, candidates: windowsProcesses, alive: processAlive }

/**
 * The plugin polls for as long as DSH runs, so PowerShell, the only query that tells
 * Main from its helpers, stays off the polling path: a poll lists PIDs with tasklist
 * or checks an identified main process by its PID, and PowerShell runs only for a
 * process with Desktop's image name that is not identified yet. Without tasklist,
 * every poll falls back to PowerShell.
 */
export function windowsDesktopProbe(queries: WindowsProcessQueries = systemWindowsQueries, now: () => number = Date.now) {
  let main: { target: string; pid: number; checkedAt: number } | null = null
  let others: { target: string; recheckAt: Map<number, number> } | null = null
  return async (target: DesktopProcessTarget): Promise<boolean> => {
    const key = JSON.stringify([target.executablePath, target.launchArgs, target.packaged])
    const current = main?.target === key && queries.alive(main.pid) ? main : null
    if (current && now() - current.checkedAt < WINDOWS_REVERIFY_MS) return true
    main = null
    const imageName = basename(target.executablePath.replaceAll('\\', '/'))
    const pids = await queries.imagePids(imageName).catch(() => null)
    // A PID another program reused would no longer run Desktop's image.
    if (current && pids?.includes(current.pid)) { main = { ...current, checkedAt: now() }; return true }
    if (pids?.length === 0) { others = null; return false }
    const known = others?.target === key ? others.recheckAt : null
    if (pids && known && pids.every(pid => (known.get(pid) ?? 0) > now())) return false
    const candidates = await queries.candidates(imageName)
    const found = candidates.find(candidate => matchesDesktopProcess(target, candidate, 'win32'))
    if (found?.pid !== undefined) main = { target: key, pid: found.pid, checkedAt: now() }
    const readable = new Set(candidates.map(candidate => candidate.pid))
    others = found || !pids ? null : {
      target: key,
      recheckAt: new Map(pids.map(pid => [pid, now() + (readable.has(pid) ? WINDOWS_REVERIFY_MS : WINDOWS_UNREADABLE_RETRY_MS)])),
    }
    return Boolean(found)
  }
}

const windowsDesktopRunning = windowsDesktopProbe()

async function linuxProcesses(target: DesktopProcessTarget): Promise<DesktopProcessCandidate[]> {
  const processes: DesktopProcessCandidate[] = []
  const entries = await readdir('/proc')
  for (const pid of entries) {
    if (!/^[1-9]\d*$/.test(pid)) continue
    try {
      const args = (await readFile(`/proc/${pid}/cmdline`)).toString('utf8').split('\0').filter(Boolean)
      if (!args.length || args.some(arg => arg.startsWith('--type='))) continue
      const executablePath = await readlink(`/proc/${pid}/exe`)
      let appImagePath: string | undefined
      let appDir: string | undefined
      let electronRunAsNode = false
      if (target.packaged && target.executablePath.toLowerCase().endsWith('.appimage') && executablePath !== target.executablePath) {
        // AppImage runs its executable from a temporary mount. APPIMAGE holds
        // the original installed path, whereas /proc/<pid>/exe does not.
        const environment = (await readFile(`/proc/${pid}/environ`)).toString('utf8').split('\0')
        appImagePath = environment.find(value => value.startsWith('APPIMAGE='))?.slice('APPIMAGE='.length)
        appDir = environment.find(value => value.startsWith('APPDIR='))?.slice('APPDIR='.length)
        electronRunAsNode = environment.some(value => value === 'ELECTRON_RUN_AS_NODE=1')
      }
      processes.push({ executablePath, commandLine: args.join(' '), ...(appImagePath ? { appImagePath } : {}),
        ...(appDir ? { appDir } : {}), electronRunAsNode })
    } catch (error) {
      // Other users' processes and processes exiting mid-scan are not candidates.
      if (!error || typeof error !== 'object' || !('code' in error) || !['ENOENT', 'EACCES', 'EPERM'].includes(String(error.code))) throw error
    }
  }
  return processes
}

/** A failed process query must not turn an installation record into proof of a live app. */
export async function isDesktopRunning(target: DesktopProcessTarget, platform = process.platform): Promise<boolean> {
  if (platform === 'win32') return windowsDesktopRunning(target)
  const processes = platform === 'darwin' ? await macProcesses()
    : platform === 'linux' ? await linuxProcesses(target) : []
  return processes.some(candidate => {
    if (platform === 'darwin') {
      const path = target.executablePath
      if (!candidate.commandLine.startsWith(path) || !/^\s|$/.test(candidate.commandLine.slice(path.length))) return false
      return matchesDesktopProcess(target, { ...candidate, executablePath: path }, platform)
    }
    return matchesDesktopProcess(target, candidate, platform)
  })
}
