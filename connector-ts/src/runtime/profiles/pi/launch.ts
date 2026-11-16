// Pi 的启动准备：本机模式绑定用户自己的 pi 与 SDK，受管环境装好 npm 运行时并写私有配置；两者都用打过补丁的
// `@openma/pi-acp` 适配器，并强制载入 AA 的审批守卫。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/definition.py（`layout`、`prepare_launch`、
// `source_changed`）与 environment.py。

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { JsonObject, ModelGatewayConfig } from '../../../application/ports/runtime-session.js'
import { acpRuntimeRootName, type JsonValue } from '../../../domain/identity/index.js'
import { fail } from '../../acp/errors.js'
import { installNpmRuntime, nodeEnvironment, nodeLaunchArguments } from '../../supervisor/npm-runtime.js'
import type { LaunchContext } from '../definition.js'
import type { LocalLaunch } from '../launch.js'
import { prepareAdapter } from './adapter.js'
import { GUARD } from './dialect.js'
import { agentDirectory, installationIdentity, probeSdk, resolveLocal, type PiInstallation } from './installation.js'
import { normalizePiSettings, prepareManagedSettings, privateJson, type PiSettings } from './settings.js'

/**
 * 受管环境锁定一个验证过的 SDK；适配器跟随 0.1.x 发布（每个补丁锚点使用前都会复核）。
 * Desktop 用同一个文件构建预装包。
 */
export const DEPENDENCIES: Readonly<Record<string, string>> = JSON.parse(
  readFileSync(fileURLToPath(new URL('./dependencies.json', import.meta.url)), 'utf8'),
) as Record<string, string>
export const ADAPTER_ENTRY = '@openma/pi-acp/dist/bin.js'
export const SDK_PACKAGE = '@earendil-works/pi-coding-agent'
/** Desktop 预装的依赖：从它播种不需要网络。 */
export const BUNDLED_RUNTIME_ENV = 'AA_PI_BUNDLED_RUNTIME'
export const NPM_ROOT_ENV = 'AA_PI_NPM_ROOT'

/** 一个 Pi 实例在磁盘上的位置。 */
export interface PiLayout {
  readonly managed: boolean
  /** 实例私有目录：进程工作目录、执行来源记录、受管会话、写入校验文件。 */
  readonly root: string
  /** 受管环境的私有配置（按配置内容分代：取消的准备不会覆盖更新的网关配置）。 */
  readonly settingsRoot: string
  readonly agentDir: string
  readonly permissionFile: string
  readonly planningDir: string
  /** 受管环境的会话目录（`--session-dir`）；本机模式用 Pi 自己的。 */
  readonly sessionDir?: string
  /** 同一台机器上所有实例共用的 npm 运行时与适配器缓存。 */
  readonly npmRoot: string
  readonly adapterRoot: string
}

/** 数据目录下 Pi 的实例目录（v2 acp/composition.py `runtime_root`）。 */
export function piInstanceRoot(dataDir: string, sessionNamespace: string, instanceId: string): string {
  return join(dataDir, 'pi', 'instances', acpRuntimeRootName(sessionNamespace, instanceId))
}

function sorted(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sorted)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key]!)]))
  return value
}

export function piLayout(context: Pick<LaunchContext, 'dataDir' | 'sessionNamespace' | 'instanceId' | 'modelGateway'>, settings: PiSettings, env: NodeJS.ProcessEnv = process.env): PiLayout {
  const root = piInstanceRoot(context.dataDir, context.sessionNamespace, context.instanceId)
  const revision = createHash('sha256').update(JSON.stringify(sorted({ settings: settings as unknown as JsonValue, gateway: (context.modelGateway ?? null) as unknown as JsonValue }))).digest('hex').slice(0, 24)
  const settingsRoot = join(root, 'configurations', revision)
  const managed = settings.executionMode === 'managed'
  const agentDir = managed ? join(settingsRoot, 'pi') : agentDirectory(settings as unknown as JsonObject, env)
  const permissionFile = managed ? join(agentDir, 'aa-permissions.json') : join(root, 'aa-permissions.json')
  const cache = env[NPM_ROOT_ENV]
  return {
    managed,
    root,
    settingsRoot,
    agentDir,
    permissionFile,
    planningDir: permissionFile.replace(/\.json$/, '.planning'),
    ...(managed ? { sessionDir: join(root, 'sessions') } : {}),
    npmRoot: cache ? cache : join(context.dataDir, 'pi', 'npm-runtimes'),
    adapterRoot: join(context.dataDir, 'pi', 'adapters'),
  }
}

/**
 * Pi、Node、适配器的升级每次启动都会复核，不算换了来源；只有运行模式或原生配置目录变了才算
 * （受管环境的私有目录按配置分代，换目录不算）。v2 `source_changed`。
 */
export function sourceChanged(previous: JsonObject | undefined, current: JsonObject): boolean {
  if (!previous) return false
  const fixed = current.mode === 'managed' ? ['mode'] : ['mode', 'agentDir']
  return fixed.some(key => JSON.stringify(previous[key]) !== JSON.stringify(current[key]))
}

/** 很慢的部分（加载 SDK 探测、依赖树摘要）按安装位置与清单修改时间缓存；升级后清单变了就重算。 */
export class PiLaunchCache {
  private readonly probes = new Map<string, Promise<void>>()
  private readonly identities = new Map<string, Promise<JsonObject>>()

  private key(installation: PiInstallation): string {
    let stamp = ''
    try {
      stamp = String(statSync(join(installation.sdk, 'package.json')).mtimeMs)
    } catch {
      stamp = 'missing'
    }
    return `${installation.node}\u0000${installation.sdk}\u0000${installation.version}\u0000${stamp}`
  }

  probe(installation: PiInstallation): Promise<void> {
    const key = this.key(installation)
    let probe = this.probes.get(key)
    if (!probe) {
      probe = probeSdk(installation)
      this.probes.set(key, probe)
      probe.catch(() => this.probes.delete(key))
    }
    return probe
  }

  identity(installation: PiInstallation): Promise<JsonObject> {
    const key = this.key(installation)
    let identity = this.identities.get(key)
    if (!identity) {
      identity = installationIdentity(installation)
      this.identities.set(key, identity)
      identity.catch(() => this.identities.delete(key))
    }
    return identity
  }
}

const sharedCache = new PiLaunchCache()

export interface PiLaunchOptions {
  readonly cache?: PiLaunchCache
  readonly env?: NodeJS.ProcessEnv
  /** 受管环境取网关模型列表（测试替换）。 */
  readonly fetch?: typeof fetch
  /** 本机 pi 的解析（测试替换）。 */
  readonly resolveLocal?: (settings: JsonObject) => Promise<PiInstallation>
}

/** v2 `prepare_launch`：每次拉起 Pi 进程之前调用。返回命令、参数与 Pi 需要的环境变量（守卫、权限、网关密钥）。 */
export async function preparePiLaunch(context: LaunchContext, options: PiLaunchOptions = {}): Promise<LocalLaunch> {
  const env = options.env ?? process.env
  const gateway: ModelGatewayConfig | undefined = context.modelGateway
  const settings = normalizePiSettings(context.settings, gateway)
  const paths = piLayout(context, settings, env)
  const cache = options.cache ?? sharedCache
  let installation: PiInstallation | undefined
  if (!paths.managed) {
    installation = await (options.resolveLocal ?? (values => resolveLocal(values, { env })))(context.settings)
    // 先拒绝不能用的本机 SDK，再下载适配器。
    await cache.probe(installation)
  }
  const bundle = env[BUNDLED_RUNTIME_ENV]
  const runtime = await installNpmRuntime(paths.npmRoot, DEPENDENCIES, ADAPTER_ENTRY, bundle ? { bundle } : {})
  const entry = runtime.script
  const modules = dirname(dirname(dirname(dirname(entry))))
  if (paths.managed) {
    await prepareManagedSettings(paths.settingsRoot, settings, gateway!, { guard: GUARD, ...(options.fetch ? { fetch: options.fetch } : {}) })
    installation = { cli: entry, node: runtime.node, sdk: join(modules, SDK_PACKAGE), version: DEPENDENCIES[SDK_PACKAGE]! }
    await cache.probe(installation)
  }
  const local = installation!
  const provenance = await cache.identity(local)
  const adapterPackage = dirname(dirname(entry))
  const adapterVersion = String((JSON.parse(await readFile(join(adapterPackage, 'package.json'), 'utf8')) as { version?: unknown }).version)
  const adapterDependencies = await cache.identity({ cli: entry, node: local.node, sdk: adapterPackage, version: adapterVersion })
  const adapter = await prepareAdapter(entry, local.sdk, paths.adapterRoot)
  const guardSha256 = createHash('sha256').update(await readFile(GUARD)).digest('hex')
  const identity: JsonObject = {
    installation: provenance,
    adapter: adapter.metadata,
    adapterDependencies,
    guardSha256,
    agentDir: paths.agentDir,
    mode: paths.managed ? 'managed' : 'local',
  }
  const recordPath = join(paths.root, 'execution-source.json')
  let previous: JsonObject | undefined
  try {
    previous = JSON.parse(await readFile(recordPath, 'utf8')) as JsonObject
  } catch {
    previous = undefined
  }
  if (sourceChanged(previous, identity)) fail('pi_execution_source_changed', '此 Pi 实例的运行模式或配置目录已变化；请恢复原配置，或新建 Pi 实例。')
  await privateJson(recordPath, identity)
  const environment: Record<string, string> = {
    PI_CODING_AGENT_DIR: paths.agentDir,
    AA_PI_PERMISSIONS_FILE: paths.permissionFile,
    AA_PI_PLANNING_DIR: paths.planningDir,
    AA_PI_GUARD_DIGEST: `sha256:${guardSha256}`,
    AA_PI_GUARD: GUARD,
  }
  const electron = nodeEnvironment(local.node)
  if (Object.keys(electron).length) {
    // Desktop 的 Electron 只对这个进程按 Node 运行；它的目录里没有给 Agent 自己的命令用的 `node`。
    Object.assign(environment, electron)
  } else {
    environment.PATH = dirname(local.node) + delimiter + (env.PATH ?? '')
  }
  if (paths.managed) environment.AA_PI_GATEWAY_KEY = gateway!.authToken
  const version = String(adapter.metadata.version)
  return {
    command: local.node,
    args: [
      ...nodeLaunchArguments(local.node), adapter.entry, '--agent-dir', paths.agentDir, '--quiet-startup', '--no-delegation',
      ...(paths.sessionDir !== undefined ? ['--session-dir', paths.sessionDir] : []),
    ],
    environment,
    releaseId: `openma-pi-acp-${version}`,
    version,
  }
}
