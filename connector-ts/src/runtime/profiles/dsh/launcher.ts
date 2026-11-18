/**
 * How the direct route starts DSH's automation ACP (`dsh --profile acp`, D7).
 *
 * The built-in Provider uses a compatible CLI on PATH or the command bundled with DSH Desktop.
 * Lower-level callers can supply a full override or use the pinned npx launcher.
 */
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** The DSH build the direct route is tested against (S7, connector-ts/test/runtime/dsh). */
export const DSH_PINNED_VERSION = '0.2.2-rc.3'

/** Installed builds outside this range are skipped: the plugin peer range is the same. */
export function supportedDshVersion(version: string): boolean {
  return /^0\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim())
}

export interface DshLaunchPlan {
  command: string
  args: string[]
  source: 'configured' | 'desktop' | 'installed' | 'npx' | 'managed'
  version?: string
}

export interface LaunchProbe {
  /** Absolute path of an executable on PATH, or undefined. */
  which(name: string): Promise<string | undefined>
  /** `<command> --version`, trimmed, or undefined when it fails. */
  version(command: string): Promise<string | undefined>
  exists(path: string): Promise<boolean>
}

export interface LaunchOptions {
  /** `settings.command` of the runtime instance: full override, no checks. */
  configured?: { command: string, args?: string[] }
  /** Candidate `dsh` executables bundled with DSH Desktop, supplied by the host. */
  desktopExecutables?: readonly string[]
  preferInstalled?: boolean
  /** Skip `npx` (offline installs); resolution then fails when nothing is installed. */
  allowNpx?: boolean
  platform?: NodeJS.Platform
}

export class DshNotInstalledError extends Error {
  constructor(readonly tried: string[]) {
    super(`DSH is not installed and npx is unavailable (tried: ${tried.join(', ') || 'nothing'})`)
  }
}

export async function resolveDshLaunch(options: LaunchOptions, probe: LaunchProbe = systemProbe()): Promise<DshLaunchPlan> {
  const acpArgs = ['--profile', 'acp']
  if (options.configured) return { command: options.configured.command, args: [...(options.configured.args ?? []), ...acpArgs], source: 'configured' }
  const tried: string[] = []
  const installedPlan = async (): Promise<DshLaunchPlan | undefined> => {
    const names = options.platform === 'win32' ? ['dsh.cmd', 'dsh.exe'] : ['dsh']
    for (const name of names) {
      const command = await probe.which(name)
      if (!command) continue
      tried.push(command)
      const version = await probe.version(command)
      if (version && supportedDshVersion(version)) return { command, args: acpArgs, source: 'installed', version }
    }
    return undefined
  }
  if (options.preferInstalled) {
    const plan = await installedPlan()
    if (plan) return plan
  }
  for (const candidate of options.desktopExecutables ?? []) {
    tried.push(candidate)
    if (!await probe.exists(candidate)) continue
    const version = await probe.version(candidate)
    if (version && supportedDshVersion(version)) return { command: candidate, args: acpArgs, source: 'desktop', version }
  }
  if (!options.preferInstalled) {
    const plan = await installedPlan()
    if (plan) return plan
  }
  if (options.allowNpx !== false) {
    const npx = await probe.which(options.platform === 'win32' ? 'npx.cmd' : 'npx')
    if (npx) return { command: npx, args: ['-y', `@deepseek-ai/dsh@${DSH_PINNED_VERSION}`, ...acpArgs], source: 'npx', version: DSH_PINNED_VERSION }
    tried.push('npx')
  }
  throw new DshNotInstalledError(tried)
}

// The bundled launcher layout is documented by DeepSeek's Desktop app.
export function desktopDshExecutables(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform === 'darwin') {
    const roots = ['/Applications', join(env.HOME || homedir(), 'Applications')]
    return roots.flatMap(root => ['DeepSeek Harness.app', 'DeepSeek Harness Desktop.app', 'DSH Desktop.app']
      .map(app => join(root, app, 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh')))
  }
  if (process.platform === 'win32') {
    return [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter((root): root is string => Boolean(root))
      .flatMap(root => ['DeepSeek Harness', 'DSH Desktop'].map(app => join(root, app, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')))
  }
  return []
}

/** Windows batch launchers need cmd.exe. Only pass fixed switches and a quoted absolute launcher path. */
export function dshInvocation(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  if (process.platform !== 'win32' || !command.toLowerCase().endsWith('.cmd')) return { command, args }
  if (!isAbsolute(command) || /["%\r\n]/u.test(command) || args.some(arg => !/^[a-z0-9_@./:-]+$/iu.test(arg))) {
    throw new Error('Invalid DSH batch invocation')
  }
  return {
    command: env.ComSpec || join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/v:off', '/s', '/c', `""${command}" ${args.join(' ')}"`],
    windowsVerbatimArguments: true as const,
  }
}

export function systemProbe(env: NodeJS.ProcessEnv = process.env): LaunchProbe {
  return {
    async which(name) {
      for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
        if (!dir) continue
        const path = join(dir, name)
        try { await access(path); return path } catch { /* next */ }
      }
      return undefined
    },
    async version(command) {
      try {
        const invocation = dshInvocation(command, ['--version'], env)
        const windowsVerbatimArguments = 'windowsVerbatimArguments' in invocation && invocation.windowsVerbatimArguments
        return await new Promise(resolve => {
          execFile(invocation.command, [...invocation.args], { windowsVerbatimArguments, timeout: 15_000, env, windowsHide: true }, (error, stdout) => {
            const line = String(stdout).trim().split(/\r?\n/).pop()?.trim()
            resolve(error || !line ? undefined : line.replace(/^v/, ''))
          })
        })
      } catch {
        return undefined
      }
    },
    async exists(path) { try { await access(path); return true } catch { return false } },
  }
}

export interface DshEnvironmentOptions {
  /** DSH_HOME of the instance; unset means DSH's default `~/.dsh`. */
  dshHome?: string
  /**
   * AA model gateway for the direct route (S7: DSH reads these from its launching
   * environment). A key stored in `$DSH_HOME/.credentials.yaml` still wins over them.
   */
  model?: { apiKey?: string, baseUrl?: string }
}

/** Child environment: the parent's, minus AA's own credentials, plus the DSH settings. */
export function dshEnvironment(base: NodeJS.ProcessEnv, options: DshEnvironmentOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || /^AGENT_SERVER_|^AA_CONNECTOR_/.test(key)) continue
    env[key] = value
  }
  if (options.dshHome) env.DSH_HOME = options.dshHome
  if (options.model?.apiKey) env.DEEPSEEK_API_KEY = options.model.apiKey
  if (options.model?.baseUrl) env.DEEPSEEK_BASE_URL = options.model.baseUrl
  return env
}
