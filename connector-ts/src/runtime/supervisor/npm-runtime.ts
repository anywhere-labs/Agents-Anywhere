// 不依赖全局 Node / npm 安装已发布的 JavaScript Runtime（Pi 的 ACP 适配器与 SDK）。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/infrastructure/npm.py
//
// 与 v2 的差别：
// - 安装锁用独占创建的锁文件（记下持有进程的 pid，持有者已退出时接管），Node 没有 flock；
// - 解压 Node 发布包用系统自带的 tar（macOS、Linux、Windows 10 起都有 bsdtar），不自带解压实现；
// - 下载用全局 fetch。

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { cp, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { fail, RuntimeFailure } from '../acp/errors.js'

export const NODE_VERSION = '22.23.2'
/** Pi 的包声明 engines ">=22.19.0"；更高的大版本也接受。 */
export const MINIMUM_NODE: readonly [number, number, number] = [22, 19, 0]
/** Desktop 传入自己的 Electron 可执行文件：告诉它按 Node 运行。 */
export const ELECTRON_NODE_ENV = 'AA_ELECTRON_NODE'
export const ELECTRON_RESET = fileURLToPath(new URL('./assets/electron-node.mjs', import.meta.url))
/** 先试配置的来源，再试官方，再试 npmmirror（它的 Node 校验和与官方一致）。每个来源用自己的校验列表。 */
export const NODE_MIRROR_ENV = 'AA_NODE_MIRROR'
const NODE_DIST_SOURCES = ['https://nodejs.org/dist', 'https://registry.npmmirror.com/-/binary/node']
export const NPM_REGISTRY_ENV = 'AA_NPM_REGISTRY'
const NPM_REGISTRY_SOURCES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']

/** 另一个 Desktop、Pi 会话或遗留的预检可能还在下载：等它，但不无限等。 */
export const LOCK_TIMEOUT_MS = 600_000
const LOCK_POLL_MS = 500
const NODE_ARCHIVE_LIMIT = 128 * 1024 * 1024

function run(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number; maxBuffer?: number }): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, [...args], {
      env: options.env ?? process.env,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      timeout: options.timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout))).stdin?.end()
  })
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 独占锁：`path` 不存在时创建并写入本进程 pid；存在时等持有者释放，持有者已退出则接管。
 * 超时报 `agent_install_busy`。返回释放函数。
 */
export async function fileLock(path: string, options: { timeoutMs?: number } = {}): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS)
  const token = `${process.pid}:${randomUUID()}`
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(token)
      await handle.close()
      return async () => {
        try {
          if ((await readFile(path, 'utf8')) === token) await unlink(path)
        } catch {
          // 已被接管或删除
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let holder = ''
    try {
      holder = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const pid = Number(holder.split(':')[0])
    if (holder !== '' && (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid))) {
      await unlink(path).catch(() => undefined)
      continue
    }
    if (Date.now() >= deadline) fail('agent_install_busy', '另一个进程正在准备 Agent 运行环境，请稍后重试。')
    await new Promise(resolvePromise => setTimeout(resolvePromise, LOCK_POLL_MS))
  }
}

function sources(variable: string, defaults: readonly string[]): string[] {
  const configured = (process.env[variable] ?? '').trim().replace(/\/+$/, '')
  return [...new Set([configured, ...defaults].filter(Boolean))]
}

/** `node` 需要的额外环境变量：Desktop 的 Electron 要被告知按 Node 运行。 */
export function nodeEnvironment(node: string): Record<string, string> {
  const configured = process.env[ELECTRON_NODE_ENV]
  if (!configured) return {}
  try {
    return realpathSync(configured) === realpathSync(node) ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  } catch {
    return {}
  }
}

/** 放在脚本之前的参数：Electron 的变量不泄漏到 Agent 运行的命令里。 */
export function nodeLaunchArguments(node: string): string[] {
  return Object.keys(nodeEnvironment(node)).length ? ['--import', pathToFileURL(ELECTRON_RESET).href] : []
}

export function versionTuple(text: string): number[] | undefined {
  const parts = text.trim().replace(/^v/, '').split('-')[0]!.split('.').map(Number)
  return parts.length >= 3 && parts.every(Number.isInteger) ? parts : undefined
}

export function atLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const a = version[index] ?? 0
    const b = minimum[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

async function supported(executable: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const version = versionTuple(await run(executable, ['--version'], { timeoutMs: 10_000, ...(env ? { env } : {}) }))
    return version !== undefined && atLeast(version, MINIMUM_NODE)
  } catch {
    return false
  }
}

export function whichExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.PATH ?? env.Path ?? ''
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const directory of path.split(process.platform === 'win32' ? ';' : delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

export interface NodePair {
  readonly node: string
  readonly npm: string
}

/** 一个带 npm 的兼容 Node；版本管理器的 shim 先解析成它当前指向的 Node。 */
export async function nodePair(executable: string): Promise<NodePair | undefined> {
  if (!isFile(executable)) return undefined
  let resolved: string
  try {
    resolved = (await run(executable, ['--print', 'process.execPath'], { timeoutMs: 10_000 })).trim()
  } catch {
    return undefined
  }
  if (!isAbsolute(resolved) || !isFile(resolved)) return undefined
  const npm = [join(dirname(resolved), 'node_modules/npm/bin/npm-cli.js'), join(dirname(dirname(resolved)), 'lib/node_modules/npm/bin/npm-cli.js')].find(isFile)
  if (npm === undefined || !(await supported(resolved))) return undefined
  return { node: realpathSync(resolved), npm: realpathSync(npm) }
}

/** Desktop 自己的可执行文件：不需要 npm 或下载就能当 Node 用。 */
export async function electronNode(): Promise<string | undefined> {
  const configured = process.env[ELECTRON_NODE_ENV]
  if (!configured || !isFile(configured)) return undefined
  if (!(await supported(configured, { ...process.env, ELECTRON_RUN_AS_NODE: '1' }))) return undefined
  return realpathSync(configured)
}

function nodeTarget(): { name: string; archive: string; executable: string } {
  const machine = ({ x64: 'x64', arm64: 'arm64' } as Record<string, string>)[process.arch]
  const target = ({ darwin: 'darwin', linux: 'linux', win32: 'win' } as Record<string, string>)[process.platform]
  if (machine === undefined || target === undefined) fail('node_platform_unsupported', '此设备平台暂不支持自动准备 Node。')
  if (target === 'linux') {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    if (!report?.header?.glibcVersionRuntime) fail('node_abi_unsupported', '自动安装的 Linux Node 运行环境需要 glibc。')
  }
  const name = `node-v${NODE_VERSION}-${target}-${machine}`
  return { name, archive: name + (target === 'win' ? '.zip' : '.tar.gz'), executable: target === 'win' ? 'node.exe' : 'bin/node' }
}

async function downloadNode(base: string, filename: string, archive: string): Promise<void> {
  const sums = await fetch(`${base}/v${NODE_VERSION}/SHASUMS256.txt`, { signal: AbortSignal.timeout(120_000) })
  if (!sums.ok) throw new Error(`HTTP ${sums.status}`)
  const expected = (await sums.text()).split('\n').map(line => line.trim().split(/\s+/)).find(fields => fields.at(-1) === filename)?.[0]
  if (!expected) fail('node_checksum_missing', 'Node 发布包缺少校验记录。')
  const response = await fetch(`${base}/v${NODE_VERSION}/${filename}`, { signal: AbortSignal.timeout(600_000) })
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
  const digest = createHash('sha256')
  const output = await open(archive, 'w', 0o600)
  let size = 0
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > NODE_ARCHIVE_LIMIT) fail('node_archive_too_large', 'Node 下载超过大小上限。')
      digest.update(chunk)
      await output.write(chunk)
    }
  } finally {
    await output.close()
  }
  if (digest.digest('hex') !== expected) fail('node_checksum_mismatch', 'Node 下载校验失败，请重试。')
}

/** 一个带 npm 的 Node：系统里兼容的，否则下载校验过的官方发布包。 */
export async function nodeRuntime(root: string, options: { onInstall?: () => void } = {}): Promise<NodePair> {
  const system = whichExecutable('node')
  if (system !== undefined) {
    const pair = await nodePair(system)
    if (pair) return pair
  }
  const target = nodeTarget()
  const destination = join(root, target.name)
  const existing = await nodePair(join(destination, target.executable))
  if (existing) return existing
  options.onInstall?.()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const staging = join(root, `.node-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  try {
    const archive = join(staging, target.archive)
    let failure: RuntimeFailure | undefined
    let downloaded = false
    for (const base of sources(NODE_MIRROR_ENV, NODE_DIST_SOURCES)) {
      try {
        await downloadNode(base, target.archive, archive)
        downloaded = true
        break
      } catch (error) {
        failure = error instanceof RuntimeFailure ? error : new RuntimeFailure({ code: 'node_download_failed', message: 'Node 下载失败，请检查网络后重试。' })
        await rm(archive, { force: true })
      }
    }
    if (!downloaded) throw failure ?? new RuntimeFailure({ code: 'node_download_failed', message: 'Node 下载失败，请检查网络后重试。' })
    // bsdtar / GNU tar 默认拒绝绝对路径和 `..` 成员。
    try {
      await run('tar', [target.archive.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', staging], { timeoutMs: 300_000 })
    } catch {
      fail('node_archive_invalid', 'Node 安装包解压失败。')
    }
    if (!(await nodePair(join(staging, target.name, target.executable)))) fail('node_install_invalid', 'Node 运行环境校验失败。')
    await rm(destination, { recursive: true, force: true })
    await rename(join(staging, target.name), destination)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const pair = await nodePair(join(destination, target.executable))
  if (!pair) fail('node_install_invalid', 'Node 运行环境校验失败。')
  return pair
}

/** 运行已安装包用的 Node；这一步不需要 npm。 */
export async function nodeExecutable(root: string, options: { onInstall?: () => void } = {}): Promise<string> {
  const system = whichExecutable('node')
  if (system !== undefined) {
    const pair = await nodePair(system)
    if (pair) return pair.node
  }
  return (await electronNode()) ?? (await nodeRuntime(root, options)).node
}

function bundleMatches(bundle: string | undefined, dependencies: Readonly<Record<string, string>>, entry: string): bundle is string {
  if (bundle === undefined) return false
  try {
    const manifest = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8')) as { dependencies?: unknown }
    const same = (a: unknown, b: Readonly<Record<string, string>>): boolean => a !== null && typeof a === 'object' && !Array.isArray(a)
      && Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([key, value]) => (a as Record<string, unknown>)[key] === value)
    return same(manifest.dependencies, dependencies) && isFile(join(bundle, 'node_modules', entry))
  } catch {
    return false
  }
}

async function npmInstall(root: string, staging: string, entry: string, onOutput?: (line: string) => void): Promise<void> {
  const { node, npm } = await nodeRuntime(root)
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (key !== 'NODE_OPTIONS' && key !== 'NODE_PATH') env[key] = value
  env.PATH = dirname(node) + delimiter + (env.PATH ?? '')
  for (const registry of sources(NPM_REGISTRY_ENV, NPM_REGISTRY_SOURCES)) {
    await rm(join(staging, 'node_modules'), { recursive: true, force: true })
    try {
      const output = await run(node, [npm, 'install', `--registry=${registry}/`, '--omit=dev', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'], { cwd: staging, env, timeoutMs: 300_000 })
      if (onOutput) for (const line of output.split('\n')) if (line.trim() !== '') onOutput(line)
    } catch {
      continue
    }
    if (isFile(join(staging, 'node_modules', entry))) return
  }
  fail('agent_install_failed', 'Agent 运行环境安装失败，请检查网络后重试。')
}

export interface NpmRuntimeOptions {
  /** Desktop 预装好的同一组依赖（`package.json` + `node_modules`）：从它复制，不需要网络。 */
  readonly bundle?: string
  readonly onInstall?: () => void
  readonly onOutput?: (line: string) => void
}

export interface NpmRuntime {
  readonly node: string
  /** 入口脚本的绝对路径。 */
  readonly script: string
}

/** 按依赖清单安装到 `root/<清单摘要>`：先用同清单的预装包，否则走 npm registry 的完整性校验。 */
export async function installNpmRuntime(root: string, dependencies: Readonly<Record<string, string>>, entry: string, options: NpmRuntimeOptions = {}): Promise<NpmRuntime> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const identity = npmRuntimeIdentity(dependencies)
  const release = await fileLock(join(root, '.install.lock'))
  const destination = join(root, identity)
  const script = join(destination, 'node_modules', entry)
  try {
    if (!(isFile(script) && existsSync(join(destination, '.ready')))) {
      options.onInstall?.()
      const staging = join(root, `.npm-${randomUUID()}`)
      await mkdir(staging, { recursive: true, mode: 0o700 })
      try {
        await writeFile(join(staging, 'package.json'), JSON.stringify({ private: true, dependencies }))
        if (bundleMatches(options.bundle, dependencies, entry)) {
          // 复制而不是链接：Desktop 更新会替换它的资源，而 Pi 实例还在用这份缓存。
          await cp(join(options.bundle, 'node_modules'), join(staging, 'node_modules'), { recursive: true, verbatimSymlinks: true })
        } else {
          await npmInstall(root, staging, entry, options.onOutput)
        }
        await writeFile(join(staging, '.ready'), identity)
        await rm(destination, { recursive: true, force: true })
        await rename(staging, destination)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    }
  } finally {
    await release()
  }
  return { node: await nodeExecutable(root, options.onInstall ? { onInstall: options.onInstall } : {}), script: resolve(script) }
}

/**
 * 安装目录名：v2 的 `sha256(json.dumps(dependencies, sort_keys=True))[:20]`（Python 默认分隔符 `, ` / `: `），
 * 同一清单在 v2 与 v3 得到同一个目录。清单只含 ASCII 包名与版本范围。
 */
export function npmRuntimeIdentity(dependencies: Readonly<Record<string, string>>): string {
  const entries = Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const text = `{${entries.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ')}}`
  return createHash('sha256').update(text).digest('hex').slice(0, 20)
}
