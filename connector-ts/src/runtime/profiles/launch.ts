// 找到定义里的本机可执行文件，启动前确认 ACP 入口可用。这里的失败都发生在任何 Agent 进程之前，是确定的失败。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/infrastructure/launch.py

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

import type { JsonObject } from '../../application/ports/runtime-session.js'
import { fail, RuntimeFailure } from '../acp/errors.js'
import { agentEnvironment } from '../supervisor/environment.js'
import type { AcpAgentDefinition } from './definition.js'

const CHECK_TIMEOUT_MS = 60_000

export interface LocalLaunch {
  /** 绝对路径；Windows npm 包装脚本解析成 `node.exe`。 */
  readonly command: string
  /** 入口前缀（Windows npm 入口脚本）加定义的固定参数。 */
  readonly args: readonly string[]
  /** 设置项映射出的环境变量（还没合并进程环境）。 */
  readonly environment: Readonly<Record<string, string>>
  /** `<runtime>-<版本>`，v2 `LaunchDefinition.release_id`。 */
  readonly releaseId: string
  readonly version?: string
}

export interface Platform {
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  readonly home: string
}

const currentPlatform = (): Platform => ({ platform: process.platform, env: process.env, home: homedir() })

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** `~`、`$VAR`、`${VAR}`、`%VAR%`（os.path.expandvars + expanduser）。未定义的变量保持原样。 */
export function expandPath(path: string, platform: Platform = currentPlatform()): string {
  const expanded = path
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, bare: string | undefined) => platform.env[braced ?? bare ?? ''] ?? match)
    .replace(/%([^%]+)%/g, (match, name: string) => (platform.platform === 'win32' ? platform.env[name] ?? match : match))
  if (expanded === '~') return platform.home
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) return join(platform.home, expanded.slice(2))
  return expanded
}

/** shutil.which：在 PATH 里找可执行文件（Windows 依次试 PATHEXT）。 */
export function which(name: string, platform: Platform = currentPlatform()): string | undefined {
  const path = platform.env.PATH ?? platform.env.Path ?? ''
  const extensions = platform.platform === 'win32'
    ? (platform.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const directory of path.split(platform.platform === 'win32' ? ';' : delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

export function candidates(definition: AcpAgentDefinition, platform: Platform = currentPlatform()): string[] {
  const executable = definition.executable
  const found = which(executable.name, platform)
  const appData = platform.platform === 'win32' ? platform.env.APPDATA : undefined
  return [
    ...(found ? [found] : []),
    ...(executable.candidates ?? []).map(item => expandPath(item, platform)),
    ...(appData && executable.windowsNpmEntry ? [join(appData, 'npm', `${executable.name}.cmd`)] : []),
  ]
}

export function resolveExecutable(definition: AcpAgentDefinition, settings: JsonObject, platform: Platform = currentPlatform()): string {
  const name = definition.executable.name
  const explicit = typeof settings.cliPath === 'string' && settings.cliPath !== '' ? settings.cliPath : undefined
  if (explicit !== undefined) {
    const path = expandPath(explicit, platform)
    if (!isAbsolute(path) || !isFile(path)) fail('agent_cli_missing', `未找到指定的 ${name}：${explicit}`)
    return resolve(path)
  }
  const path = candidates(definition, platform).find(isFile)
  if (path === undefined) fail('agent_cli_missing', `未找到本机 ${name}。请先安装 ${definition.displayName}，或在实例配置中填写 ${name} 路径。`)
  return resolve(path)
}

/** Windows 上 `.cmd`/`.bat`/`.ps1` 不能不经 shell 直接运行：已知的 npm 包装脚本改成 node + 包入口。 */
export function launchCommand(definition: AcpAgentDefinition, path: string, platform: Platform = currentPlatform()): string[] {
  if (platform.platform !== 'win32' || !['.cmd', '.bat', '.ps1'].includes(extname(path).toLowerCase())) return [path]
  const entry = definition.executable.windowsNpmEntry
  if (entry !== undefined) {
    let node: string | undefined = join(dirname(path), 'node.exe')
    if (!isFile(node)) node = which('node', platform)
    let script = join(dirname(path), 'node_modules', entry)
    if (!isFile(script)) script = join(dirname(dirname(path)), entry) // 项目内 node_modules/.bin
    if (node !== undefined && isFile(script)) return [resolve(node), script]
  }
  return fail('agent_cli_unsupported', `无法直接启动 ${definition.executable.name} 的批处理入口，请确认 Node.js 与 CLI 安装完整，或填写实际可执行文件的路径。`)
}

export function launchEnvironment(definition: AcpAgentDefinition, settings: JsonObject, platform: Platform = currentPlatform()): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const setting of definition.settings ?? []) {
    const value = settings[setting.key]
    if (typeof value === 'string' && value !== '') environment[setting.environment] = resolve(expandPath(value, platform))
  }
  return environment
}

export function runCheck(definition: AcpAgentDefinition, command: readonly string[], args: readonly string[], environment: Readonly<Record<string, string>>, platform: Platform = currentPlatform()): Promise<string> {
  const name = basename(command.at(-1) ?? definition.executable.name)
  return new Promise((resolvePromise, reject) => {
    execFile(command[0]!, [...command.slice(1), ...args], {
      cwd: platform.home,
      env: agentEnvironment(environment, { base: platform.env }),
      timeout: CHECK_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        const spawnFailed = typeof (error as NodeJS.ErrnoException).code === 'string' || error.killed
        reject(new RuntimeFailure(spawnFailed
          ? { code: 'agent_acp_unavailable', message: `无法运行 ${name} ${args.join(' ')}，请确认 ${definition.displayName} 安装完整。` }
          : { code: 'agent_acp_unavailable', message: `${definition.displayName} 的 ACP 入口不可用，请确认能在本机运行 ${name} ${args.join(' ')}。` }))
        return
      }
      resolvePromise(stdout.trim())
    }).stdin?.end()
  })
}

/** 解析可执行文件、检查 ACP 入口、读版本（v2 `local_launch`）。 */
export async function localLaunch(definition: AcpAgentDefinition, settings: JsonObject, platform: Platform = currentPlatform()): Promise<LocalLaunch> {
  const path = resolveExecutable(definition, settings, platform)
  const command = launchCommand(definition, path, platform)
  const environment = launchEnvironment(definition, settings, platform)
  if (definition.check) await runCheck(definition, command, definition.check, environment, platform)
  const version = definition.version ? (await runCheck(definition, command, definition.version, environment, platform)).split('\n').map(line => line.trim()).filter(Boolean).at(-1) : undefined
  return {
    command: command[0]!,
    args: [...command.slice(1), ...definition.arguments],
    environment,
    releaseId: `${definition.runtime}-${version ?? 'unknown'}`,
    ...(version !== undefined ? { version } : {}),
  }
}
