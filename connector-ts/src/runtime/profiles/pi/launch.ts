// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/definition.py @98dd0e6e5 (layout, prepare_launch, source_changed)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/environment.py @98dd0e6e5 (npm_root, bundled_runtime, prepare_environment)
//
// Pi launch preparation: local mode binds the user's own pi and SDK; the managed environment installs the npm runtime
// and writes private config. Both use the patched `@openma/pi-acp` adapter and force-load AA's approval guard.

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
 * The managed environment pins one verified SDK; the adapter follows 0.1.x releases (every patch anchor is re-verified
 * before use). Desktop builds its preinstalled bundle from the same file.
 */
export const DEPENDENCIES: Readonly<Record<string, string>> = JSON.parse(
  readFileSync(fileURLToPath(new URL('./dependencies.json', import.meta.url)), 'utf8'),
) as Record<string, string>
export const ADAPTER_ENTRY = '@openma/pi-acp/dist/bin.js'
export const SDK_PACKAGE = '@earendil-works/pi-coding-agent'
/** Dependencies preinstalled by Desktop: seeding from them needs no network. */
export const BUNDLED_RUNTIME_ENV = 'AA_PI_BUNDLED_RUNTIME'
export const NPM_ROOT_ENV = 'AA_PI_NPM_ROOT'

/** Where a Pi instance lives on disk. */
export interface PiLayout {
  readonly managed: boolean
  /** Instance private directory: process working directory, execution source record, managed sessions, write verification files. */
  readonly root: string
  /**
   * Managed environment private config (one generation per config content, so a cancelled preparation cannot
   * overwrite a newer gateway config).
   */
  readonly settingsRoot: string
  readonly agentDir: string
  readonly permissionFile: string
  readonly planningDir: string
  /** Managed environment session directory (`--session-dir`); local mode uses Pi's own. */
  readonly sessionDir?: string
  /** npm runtime and adapter cache shared by all instances on the machine. */
  readonly npmRoot: string
  readonly adapterRoot: string
}

/** Pi instance directory under the data directory; the name must stay stable so existing instance directories are found. */
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
 * Upgrades of Pi, Node or the adapter are re-verified on every start and do not count as a source change; only a change
 * of execution mode or native config directory does (the managed environment's private directory is per config
 * generation, so changing it does not count).
 */
export function sourceChanged(previous: JsonObject | undefined, current: JsonObject): boolean {
  if (!previous) return false
  const fixed = current.mode === 'managed' ? ['mode'] : ['mode', 'agentDir']
  return fixed.some(key => JSON.stringify(previous[key]) !== JSON.stringify(current[key]))
}

/**
 * The slow parts (loading the SDK probe, dependency tree digest) are cached by install location and manifest mtime;
 * they are recomputed when an upgrade changes the manifest.
 */
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
  /** Fetches the gateway model list for the managed environment (replaced by tests). */
  readonly fetch?: typeof fetch
  /** Local pi resolution (replaced by tests). */
  readonly resolveLocal?: (settings: JsonObject) => Promise<PiInstallation>
}

/**
 * Called before every Pi process start. Returns the command, arguments and the environment variables Pi needs (guard,
 * permission, gateway key).
 */
export async function preparePiLaunch(context: LaunchContext, options: PiLaunchOptions = {}): Promise<LocalLaunch> {
  const env = options.env ?? process.env
  const gateway: ModelGatewayConfig | undefined = context.modelGateway
  const settings = normalizePiSettings(context.settings, gateway)
  const paths = piLayout(context, settings, env)
  const cache = options.cache ?? sharedCache
  let installation: PiInstallation | undefined
  if (!paths.managed) {
    installation = await (options.resolveLocal ?? (values => resolveLocal(values, { env })))(context.settings)
    // Reject an unusable local SDK before downloading the adapter.
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
    // Desktop's Electron runs as Node only for this process; its directory has no `node` for the Agent's own commands.
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
