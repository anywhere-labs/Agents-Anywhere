import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { ResolvedConfig } from '../config.js'

/** What runs the bundled Connector: this host's own Node (or Electron as Node), the entry and the Router. */
export interface ConnectorLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  /** The MeshCall Router for this platform the Connector starts for its local control channel. */
  router: string
}

const routerName = (platform: NodeJS.Platform) => platform === 'win32' ? 'meshcall-router.exe' : 'meshcall-router'

/**
 * Some package managers unpack bundled binaries without their executable bit. Restore
 * it in place, or use a private copy when the install directory is read-only.
 */
export async function ensureExecutable(file: string, fallbackDirectory: string, setMode: typeof chmod = chmod): Promise<string> {
  try { await access(file, constants.X_OK); return file } catch { await access(file, constants.F_OK) }
  try {
    await setMode(file, 0o755)
    await access(file, constants.X_OK)
    return file
  } catch { /* Not ours to change: fall back to a copy. */ }
  const target = join(fallbackDirectory, basename(file))
  await mkdir(fallbackDirectory, { recursive: true })
  // A rename can replace a binary that is currently running; copying over it cannot.
  const partial = `${target}.${process.pid}`
  await copyFile(file, partial)
  await chmod(partial, 0o755)
  await rename(partial, target)
  return target
}

/**
 * The command line of the bundled Connector (`<connectorDir>/anywhere-cli.js`, built from connector-ts). It runs on
 * the Node that runs DSH; under DSH Desktop that is Electron, told to act as Node, with a preload that keeps
 * `ELECTRON_RUN_AS_NODE` out of the commands the Connector starts. `MESHCALL_ROUTER_BINARY` overrides the bundled
 * Router (development builds carry none).
 */
export async function resolveConnectorLaunch(config: ResolvedConfig, configPath: string, host: {
  execPath: string, platform: NodeJS.Platform, arch: string, electron: boolean, env: NodeJS.ProcessEnv,
} = { execPath: process.execPath, platform: process.platform, arch: process.arch, electron: Boolean(process.versions.electron), env: process.env }): Promise<ConnectorLaunch> {
  const entry = join(config.connectorDir, 'anywhere-cli.js')
  try { await access(entry, constants.R_OK) } catch { throw new Error('未找到内置 Connector，请重新安装插件。') }
  const target = `${host.platform}-${host.arch}`
  const configured = host.env['MESHCALL_ROUTER_BINARY']?.trim()
  let router: string
  try {
    router = configured || await ensureExecutable(join(config.connectorDir, 'router', target, routerName(host.platform)), join(config.stateRoot, 'bin'))
  } catch {
    throw new Error(`内置 Connector 不支持这台电脑的平台（${target}）。`)
  }
  const reset = join(config.connectorDir, 'assets', 'electron-node.mjs')
  return {
    command: host.execPath,
    args: [...host.electron ? ['--import', pathToFileURL(reset).href] : [], entry, 'rpc', '--config', configPath],
    env: host.electron ? { ELECTRON_RUN_AS_NODE: '1', AA_ELECTRON_NODE: host.execPath } : {},
    router,
  }
}

/**
 * What the Python Connector of plugin 2.x left in the plugin's data directory: its uv environment, the
 * materialized source with its uv.lock, and the private copy of uv. Removed once; nothing here is used any more.
 */
export async function removePythonEnvironment(stateRoot: string): Promise<void> {
  for (const path of [['connector-venv'], ['connector-source'], ['bin', 'uv'], ['bin', 'uv.exe']]) {
    // Windows can hold a file briefly after a process exits.
    await rm(join(stateRoot, ...path), { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
}

export function canOpenFolders(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32' || Boolean(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'])
}

/** Called only for a Host-owned directory selected by the user, never a client-supplied path. */
export async function openFolder(path: string): Promise<void> {
  if (!canOpenFolders()) throw new Error('当前环境不支持打开本机目录。')
  await mkdir(path, { recursive: true, mode: 0o700 })
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  try {
    // explorer.exe hands the request to the running shell and exits with code 1 even on
    // success, so on Windows only a failure to launch it counts as a failure.
    if (process.platform === 'win32') await launchDetached(command, [path])
    else await promisify(execFile)(command, [path], { timeout: 5_000, windowsHide: true })
  } catch { throw new Error('无法打开目录，请检查本机文件管理器是否可用。') }
}

/** Starts a process without waiting for it: resolves once it launched, ignoring its exit code. */
export function launchDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
