/**
 * DSH session identity across both routes (DSH-2, 04-connector.md §5.6 "会话 ID").
 *
 * - The source key depends only on DSH_HOME (the 1.x endpoint path under it, as v2), so
 *   both routes, and sessions created by v2, map to the same AA session IDs.
 * - The plugin route lets AA choose the native ID (`aa_<ns digest>_<platform id>`), which the
 *   formula inverts. DSH's automation ACP (direct route) only mints random UUIDs, so the
 *   Connector records "platform session ID <-> DSH ID" aliases and every lookup checks them first.
 * - A `session/new` whose answer was lost (DSH crashed, Connector restarted) must not
 *   create a second session on retry: the creation intent is recorded before the call and
 *   reconciled against `session/list` afterwards.
 */
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { dshPluginNativeSessionId, dshPluginSessionId } from '../../../domain/identity/dsh.js'
import { dshSessionSourceKey, sessionNamespace, type HostPlatform, type SourceKey } from '../../../domain/identity/session.js'

export interface DshAlias {
  platformSessionId: string
  dshSessionId: string
  route: 'direct' | 'plugin'
  cwd: string
  createdAt: number
}

export interface DshCreationIntent {
  platformSessionId: string
  cwd: string
  startedAt: number
  /** DSH session IDs already listed for this cwd before `session/new` was sent. */
  knownBefore: string[]
}

/**
 * Persistent alias table. The Connector's SQLite store (A, `store/`) implements it and
 * the composition root wires it in; `MemoryAliasStore` serves tests and the CLI probe.
 */
export interface DshAliasStore {
  byPlatform(platformSessionId: string): Promise<DshAlias | undefined>
  byDsh(dshSessionId: string): Promise<DshAlias | undefined>
  put(alias: DshAlias): Promise<void>
  intent(platformSessionId: string): Promise<DshCreationIntent | undefined>
  putIntent(intent: DshCreationIntent): Promise<void>
  deleteIntent(platformSessionId: string): Promise<void>
}

export class MemoryAliasStore implements DshAliasStore {
  readonly aliases = new Map<string, DshAlias>()
  readonly intents = new Map<string, DshCreationIntent>()
  async byPlatform(id: string) { return this.aliases.get(id) }
  async byDsh(id: string) { return [...this.aliases.values()].find(alias => alias.dshSessionId === id) }
  async put(alias: DshAlias) {
    const clash = await this.byDsh(alias.dshSessionId)
    if (clash && clash.platformSessionId !== alias.platformSessionId) throw new Error('DSH session is already aliased to another AA session')
    this.aliases.set(alias.platformSessionId, alias)
  }
  async intent(id: string) { return this.intents.get(id) }
  async putIntent(intent: DshCreationIntent) { this.intents.set(intent.platformSessionId, intent) }
  async deleteIntent(id: string) { this.intents.delete(id) }
}

/** connector/runtime_protocol/filesystem.py `canonical_path`: resolve existing components, keep the rest. */
export async function canonicalPath(path: string, platform: HostPlatform = process.platform as HostPlatform): Promise<string> {
  const absolute = resolve(path.startsWith('~') ? join(homedir(), path.slice(1)) : path)
  const tail: string[] = []
  let current = absolute
  for (;;) {
    try {
      const real = await realpath(current)
      const joined = tail.length ? join(real, ...tail.reverse()) : real
      return platform === 'win32' ? joined.toLowerCase().replaceAll('/', '\\') : joined
    } catch {
      const parent = dirname(current)
      if (parent === current) return platform === 'win32' ? absolute.toLowerCase() : absolute
      tail.push(basename(current))
      current = parent
    }
  }
}

/** provider_config.py `dsh_home`: configured `dshHome`, else $DSH_HOME, else ~/.dsh. */
export function dshHomeOf(settings: { dshHome?: string }, env: NodeJS.ProcessEnv = process.env): string {
  if (settings.dshHome) {
    if (!isAbsolute(settings.dshHome) && !settings.dshHome.startsWith('~')) throw new Error('dshHome must be an absolute path.')
    return settings.dshHome
  }
  return env.DSH_HOME || join(homedir(), '.dsh')
}

export async function dshSourceKey(settings: { dshHome?: string }, env: NodeJS.ProcessEnv = process.env,
  platform: HostPlatform = process.platform as HostPlatform): Promise<SourceKey> {
  return dshSessionSourceKey(await canonicalPath(dshHomeOf(settings, env), platform), platform)
}

export class DshSessionIds {
  constructor(readonly namespace: string, private readonly aliases: DshAliasStore) {}

  static async forInstance(identity: { connectorId: string, runtimeId: string }, settings: { dshHome?: string },
    aliases: DshAliasStore, env: NodeJS.ProcessEnv = process.env, platform: HostPlatform = process.platform as HostPlatform) {
    const sourceKey = await dshSourceKey(settings, env, platform)
    return new DshSessionIds(sessionNamespace({ connectorId: identity.connectorId, runtimeType: 'dsh', runtimeId: identity.runtimeId, sourceKey }), aliases)
  }

  /** AA session ID of a DSH session, from either route. */
  async platformId(dshSessionId: string): Promise<string> {
    const alias = await this.aliases.byDsh(dshSessionId)
    return alias?.platformSessionId ?? dshPluginSessionId(this.namespace, dshSessionId)
  }

  /**
   * DSH session ID of an AA session when it can be derived: the alias table, else the
   * plugin-route ID AA assigns. Sessions discovered from DSH (hash IDs) are looked up by
   * the caller's session record, not here.
   */
  async dshId(platformSessionId: string): Promise<string | undefined> {
    const alias = await this.aliases.byPlatform(platformSessionId)
    if (alias) return alias.dshSessionId
    try { return dshPluginNativeSessionId(this.namespace, platformSessionId) } catch { return undefined }
  }

  /** Native ID to request when the plugin route creates the session (contracts/dsh-bridge/3.0 §3). */
  pluginNativeId(platformSessionId: string): string {
    return dshPluginNativeSessionId(this.namespace, platformSessionId)
  }

  async remember(alias: DshAlias): Promise<void> { await this.aliases.put(alias) }
  get store(): DshAliasStore { return this.aliases }
}
