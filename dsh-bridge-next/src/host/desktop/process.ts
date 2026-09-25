import { execFile } from 'node:child_process'
import { readFile, readdir, readlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HELPER_ARGUMENT = /(?:^|\s)--type(?:=|\s)/
const BACKEND_ARGUMENT = /[\\/]backend[\\/]index\.js(?=["'\s]|$)/i

export interface DesktopProcessTarget {
  executablePath: string
  launchArgs: string[]
  packaged: boolean
}

export interface DesktopProcessCandidate {
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

/** Never confuse Electron renderer/GPU helpers or another development Electron app with Main. */
export function matchesDesktopProcess(target: DesktopProcessTarget, candidate: DesktopProcessCandidate, platform: string): boolean {
  const executableMatches = candidate.executablePath !== undefined && samePath(candidate.executablePath, target.executablePath, platform)
  const appImageMatches = platform === 'linux' && target.packaged && candidate.appImagePath !== undefined &&
    samePath(candidate.appImagePath, target.executablePath, platform) && candidate.appDir !== undefined &&
    candidate.executablePath?.startsWith(`${candidate.appDir}/`)
  if (!executableMatches && !appImageMatches) return false
  if (HELPER_ARGUMENT.test(candidate.commandLine) || BACKEND_ARGUMENT.test(candidate.commandLine) || candidate.electronRunAsNode) return false
  return target.packaged || target.launchArgs.every(argument => hasArgument(candidate.commandLine, argument, platform))
}

async function macProcesses(): Promise<DesktopProcessCandidate[]> {
  const { stdout } = await run('/bin/ps', ['-axo', 'command=', '-ww'], { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 })
  // ps has no argv array. The leading executable is the recorded absolute path;
  // matching it with an argument boundary also supports paths containing spaces.
  return stdout.split('\n').filter(Boolean).map(commandLine => ({ commandLine }))
}

async function windowsProcesses(target: DesktopProcessTarget): Promise<DesktopProcessCandidate[]> {
  const name = basename(target.executablePath.replaceAll('\\', '/')).replaceAll("'", "''")
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter "Name = '${name}'" | Select-Object ExecutablePath,CommandLine) | ConvertTo-Json -Compress`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    timeout: 5_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  })
  const result: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
  const entries = Array.isArray(result) ? result : result ? [result] : []
  return entries.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as Record<string, unknown>
    return typeof value.ExecutablePath === 'string' && typeof value.CommandLine === 'string'
      ? [{ executablePath: value.ExecutablePath, commandLine: value.CommandLine }] : []
  })
}

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
  const processes = platform === 'darwin' ? await macProcesses()
    : platform === 'win32' ? await windowsProcesses(target)
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
