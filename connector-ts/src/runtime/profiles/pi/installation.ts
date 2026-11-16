// 把本机 pi 解析到它自己的 SDK；从不往用户的包里安装东西。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/installation.py

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { open, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'

import type { JsonObject } from '../../../application/ports/runtime-session.js'
import { acpFingerprint, type JsonValue } from '../../../domain/identity/index.js'
import { fail } from '../../acp/errors.js'
import { expandPath } from '../launch.js'
import { atLeast, nodeEnvironment, versionTuple, whichExecutable } from '../../supervisor/npm-runtime.js'

export const PACKAGE = '@earendil-works/pi-coding-agent'
/** 本机交接脚本验证过的下限；1.1.0 的安装导入不了自己的 SDK。 */
export const MINIMUM_SDK: readonly [number, number, number] = [1, 2, 0]
export const SUPPORTED_MAJOR = 1
const MINIMUM_NODE = [22, 19, 0]

export interface PiInstallation {
  /** pi 入口（解析后的绝对路径）。 */
  readonly cli: string
  readonly node: string
  /** SDK 包根目录（含 package.json、dist/index.js）。 */
  readonly sdk: string
  readonly version: string
}

export function sdkVersionSupported(version: unknown): boolean {
  if (typeof version !== 'string') return false
  const parts = version.split('-')[0]!.split('.').map(Number)
  if (parts.length !== 3 || !parts.every(Number.isInteger)) return false
  return parts[0] === SUPPORTED_MAJOR && atLeast(parts, MINIMUM_SDK)
}

export function supportedSdkRange(): string {
  return `>=${MINIMUM_SDK.join('.')} <${SUPPORTED_MAJOR + 1}`
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Pi 的配置目录：实例配置、`PI_CODING_AGENT_DIR`、`~/.pi/agent`。 */
export function agentDirectory(settings: JsonObject, env: NodeJS.ProcessEnv = process.env): string {
  const configured = text(settings.agentDir) ?? text(env.PI_CODING_AGENT_DIR) ?? '~/.pi/agent'
  return resolve(expandPath(configured))
}

/** 原生历史的来源目录：`<agentDir>/sessions`、settings.json 的 `sessionDir`、实例配置里的额外目录。 */
export function historyDirectories(settings: JsonObject, agentDir: string): string[] {
  const paths = [join(agentDir, 'sessions')]
  try {
    const setting = (JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')) as { sessionDir?: unknown }).sessionDir
    if (typeof setting === 'string' && setting !== '') paths.push(expandPath(setting))
  } catch {
    // 没有或读不了 settings.json
  }
  for (const value of Array.isArray(settings.historyDirs) ? settings.historyDirs : []) if (typeof value === 'string' && value !== '') paths.push(expandPath(value))
  return [...new Set(paths.map(path => resolve(path)))]
}

function packageFor(entry: string): string | undefined {
  let root: string
  try {
    root = realpathSync(entry)
  } catch {
    return undefined
  }
  for (let current = dirname(root); current !== dirname(current); current = dirname(current)) {
    try {
      if ((JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as { name?: unknown }).name === PACKAGE) return current
    } catch {
      continue
    }
  }
  return undefined
}

function exec(command: string, args: readonly string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, [...args], { timeout: options.timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: options.env ?? process.env }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout))).stdin?.end()
  })
}

export interface ResolveOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly platform?: NodeJS.Platform
}

/** 解析本机 pi：指定路径，或 PATH，或常见安装位置（多处都有时要求用户指定）；再找 Node 22.19+ 与它自带的 SDK。 */
export async function resolveLocal(settings: JsonObject, options: ResolveOptions = {}): Promise<PiInstallation> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const windows = (options.platform ?? process.platform) === 'win32'
  const specified = text(settings.cliPath)
  let command = specified !== undefined ? expandPath(specified) : whichExecutable('pi', env)
  if (command === undefined && specified === undefined) {
    const candidates = [
      join(home, '.nvmd/bin/pi'), join(home, '.local/bin/pi'), join(home, '.npm-global/bin/pi'), join(home, '.npm/bin/pi'),
      '/opt/homebrew/bin/pi', '/usr/local/bin/pi',
      ...(windows ? [join(env.APPDATA ?? join(home, 'AppData/Roaming'), 'npm/pi.cmd')] : []),
    ]
    const found = candidates.filter(isFile)
    if (found.length > 1) fail('pi_installation_ambiguous', `发现多个本机 Pi 安装，请在 CLI 路径中选择：${found.join('、')}`)
    command = found[0]
  }
  if (command === undefined || !isFile(command)) fail('pi_cli_missing', '未找到本机 pi，请指定 CLI 路径或明确选择受管环境。')
  let cli = resolve(command)
  let root = packageFor(cli)
  const nodeName = windows ? 'node.exe' : 'node'
  const nodeCandidates = [join(dirname(cli), nodeName)]
  const fromPath = whichExecutable('node', env)
  if (fromPath !== undefined) nodeCandidates.push(fromPath)
  nodeCandidates.push(join(home, '.nvmd/bin/node'), join(home, '.local/bin/node'), '/opt/homebrew/bin/node', '/usr/local/bin/node')
  // <prefix>/lib/node_modules/@earendil-works/pi-coding-agent → <prefix>/bin/node
  if (root !== undefined) nodeCandidates.push(join(root, '../../../../bin/node'))
  let node: string | undefined
  for (const candidate of nodeCandidates) {
    if (!isFile(candidate)) continue
    try {
      const report = JSON.parse(await exec(candidate, ['--print', 'JSON.stringify({path:process.execPath,version:process.versions.node})'], { timeoutMs: 10_000 })) as { path?: unknown; version?: unknown }
      const version = typeof report.version === 'string' ? versionTuple(report.version) : undefined
      if (version !== undefined && atLeast(version, MINIMUM_NODE) && typeof report.path === 'string') {
        node = realpathSync(report.path)
        break
      }
    } catch {
      continue
    }
  }
  if (node === undefined) fail('pi_node_incompatible', '本机 Pi 需要可用的 Node 22.19 或更高版本。')
  const shim = join(dirname(cli), nodeName)
  if (root === undefined && specified === undefined && isFile(shim) && sameFile(shim, cli)) {
    // 版本管理器的 shim（例如 nvmd）和当前 Node 共用 bin 目录：只看当前那份安装，不挑任意版本。
    for (const entry of [join(dirname(node), 'pi'), join(dirname(node), 'pi.cmd')]) {
      const found = isFile(entry) ? packageFor(entry) : undefined
      if (found !== undefined) {
        cli = entry
        root = found
        break
      }
    }
  }
  if (root === undefined && ['.cmd', '.ps1'].includes(extname(cli).toLowerCase())) {
    // npm 的 Windows 启动脚本指向旁边的 node_modules，不是符号链接。
    const candidate = join(dirname(cli), 'node_modules', PACKAGE)
    if (isFile(join(candidate, 'package.json'))) root = candidate
  }
  if (root === undefined) fail('pi_installation_unsupported', '无法将此 pi 入口绑定到兼容 SDK；请指定 npm 安装的真实 pi 入口。')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
  if (!sdkVersionSupported(manifest.version) || !isFile(join(root, 'dist/index.js'))) {
    fail('pi_sdk_incompatible', `本机 Pi ${String(manifest.version)} 不受支持，需要 ${supportedSdkRange()} 的 npm 安装；不会使用其他 SDK 替代。`)
  }
  return { cli: realpathSync(cli), node, sdk: realpathSync(root), version: String(manifest.version) }
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

const SDK_PROBE = String.raw`
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
const missing = [];
const fn = (value, name) => { if (typeof value !== 'function') missing.push(name) };
let version;
try {
  const sdk = await import(pathToFileURL(process.argv[1] + '/dist/index.js').href);
  version = sdk.VERSION;
  fn(sdk.createAgentSessionServices, 'createAgentSessionServices');
  fn(sdk.createAgentSessionFromServices, 'createAgentSessionFromServices');
  const manager = sdk.SessionManager;
  for (const name of ['open', 'create', 'forkFrom']) fn(manager?.[name], 'SessionManager.' + name);
  for (const name of ['_persist', '_rewriteFile', 'getSessionFile', 'getSessionId']) fn(manager?.prototype?.[name], 'SessionManager#' + name);
  const manifest = createRequire(process.argv[1] + '/package.json').resolve('@earendil-works/pi-agent-core/package.json');
  const data = JSON.parse(readFileSync(manifest, 'utf8'));
  const exported = data.exports?.['.'];
  const entry = typeof exported === 'string' ? exported : exported?.import ?? exported?.default ?? data.main ?? 'index.js';
  const core = await import(pathToFileURL(join(dirname(manifest), entry)).href);
  for (const name of ['prompt', 'steer', 'followUp', 'normalizePromptInput']) fn(core.Agent?.prototype?.[name], 'Agent#' + name);
} catch (error) {
  console.log(JSON.stringify({error: String(error?.message ?? error).slice(0, 300)}));
  process.exit(0);
}
console.log(JSON.stringify({version, missing}));
`

/** 载入一次 SDK，检查 AA 的 bridge 要包装的入口都在。 */
export async function probeSdk(installation: PiInstallation): Promise<void> {
  let report: { error?: unknown; missing?: unknown }
  try {
    const output = await exec(installation.node, ['--input-type=module', '-e', SDK_PROBE, installation.sdk], {
      timeoutMs: 60_000, env: { ...process.env, ...nodeEnvironment(installation.node) },
    })
    report = JSON.parse(output.trim().split('\n').at(-1) ?? '') as typeof report
  } catch {
    fail('pi_sdk_incompatible', `无法加载 Pi ${installation.version} 的 SDK。`)
  }
  if (report.error) fail('pi_sdk_incompatible', `无法加载 Pi ${installation.version} 的 SDK：${String(report.error)}`)
  if (Array.isArray(report.missing) && report.missing.length) {
    fail('pi_sdk_incompatible', `Pi ${installation.version} 缺少 AA 需要的接口（${report.missing.join('、')}），暂不支持此版本。`)
  }
}

/** 包内发布的文件（含原生模块）的摘要，不含嵌套的包。 */
export async function treeDigest(root: string): Promise<string> {
  const digest = createHash('sha256')
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries.filter(e => e.isFile())) {
      const path = join(directory, entry.name)
      digest.update(relative(root, path))
      const handle = await open(path, 'r')
      try {
        for await (const chunk of handle.createReadStream()) digest.update(chunk as Buffer)
      } finally {
        await handle.close().catch(() => undefined)
      }
    }
    for (const entry of entries.filter(e => e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git')) await walk(join(directory, entry.name))
  }
  await walk(root)
  return digest.digest('hex')
}

const DEPENDENCY_WALK = String.raw`
import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
const pending=[process.argv[1]], seen=new Map();
while(pending.length){
 const manifest=pending.pop(); if(seen.has(manifest))continue;
 const data=JSON.parse(readFileSync(manifest,'utf8')); seen.set(manifest,{path:manifest,name:data.name,version:data.version});
 const req=createRequire(manifest);
 for(const name of Object.keys({...data.dependencies,...data.optionalDependencies})){
  let found;try{found=req.resolve(name+'/package.json')}catch{
   try{let p=dirname(req.resolve(name));while(p!==dirname(p)){const f=join(p,'package.json');
    if(existsSync(f)&&JSON.parse(readFileSync(f,'utf8')).name===name){found=f;break}p=dirname(p)}}catch{}
  }
  if(found)pending.push(found);
 }
}
console.log(JSON.stringify([...seen.values()]));
`

/** 安装来源的完整身份：入口、Node、SDK 与它依赖的每个包（路径、版本、文件摘要）。 */
export async function installationIdentity(installation: PiInstallation): Promise<JsonObject> {
  let packages: Array<{ path: string; name?: string; version?: string; sha256?: string }>
  try {
    packages = JSON.parse(await exec(installation.node, ['--input-type=module', '-e', DEPENDENCY_WALK, join(installation.sdk, 'package.json')], {
      timeoutMs: 30_000, env: { ...process.env, ...nodeEnvironment(installation.node) },
    })) as typeof packages
  } catch {
    fail('pi_dependency_resolution_failed', '无法校验本机 Pi 的完整依赖来源。')
  }
  for (const item of packages) item.sha256 = await treeDigest(dirname(item.path))
  const value: JsonObject = {
    cli: installation.cli,
    node: installation.node,
    nodeSha256: createHash('sha256').update(await readFile(installation.node)).digest('hex'),
    sdk: installation.sdk,
    version: installation.version,
    packages: packages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) as unknown as JsonValue,
  }
  return { ...value, digest: acpFingerprint(value as JsonValue) }
}
