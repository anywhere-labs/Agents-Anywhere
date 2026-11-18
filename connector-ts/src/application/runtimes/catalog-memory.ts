import type { Log, RuntimeKv } from '../ports/index.js'
import type { RuntimeInstanceSpec } from './instances.js'

const KEY = 'catalogs:last'

/** The catalog kinds a Runtime instance reports, each a `{ ..., <items>: [] }` object. */
const ITEMS: Readonly<Record<string, string>> = { models: 'models', permissions: 'permissions' }

type Catalogs = Record<string, unknown>

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function hasItems(catalogs: Catalogs | null, kind: string): boolean {
  const items = record(catalogs?.[kind])?.[ITEMS[kind]!]
  return Array.isArray(items) && items.length > 0
}

/** Whether `catalogs` lists any model (an ACP Agent with no open session lists none). */
export function hasModels(catalogs: Catalogs | null): boolean {
  return hasItems(catalogs, 'models')
}

/** What the catalogs depend on: the instance's type, settings, gateway and source, not its name or revision. */
function specKey(spec: RuntimeInstanceSpec): string {
  return JSON.stringify({ runtimeType: spec.runtimeType, settings: spec.settings, modelGateway: spec.modelGateway ?? null, sourceKey: spec.sourceKey })
}

/**
 * The last non-empty catalogs of each Runtime instance, kept in the store across restarts. ACP Agents report models
 * only for an open session, so after a restart the new-session page would otherwise see none until some session is
 * opened. A remembered catalog is used only while the instance's spec is unchanged.
 */
export class RuntimeCatalogMemory {
  public constructor(private readonly kv: RuntimeKv, private readonly log?: Log) {}

  public async remember(spec: RuntimeInstanceSpec, catalogs: Catalogs | null): Promise<void> {
    if (!hasModels(catalogs)) return
    try {
      const stored = record(await this.kv.get(spec.runtimeId, KEY))
      const key = specKey(spec)
      if (stored?.specKey === key && JSON.stringify(stored.catalogs) === JSON.stringify(catalogs)) return
      await this.kv.set(spec.runtimeId, KEY, { specKey: key, catalogs })
    } catch (error) {
      this.log?.('warn', `remembering the catalogs of ${spec.runtimeId} failed: ${(error as Error)?.message ?? String(error)}`)
    }
  }

  public async recall(spec: RuntimeInstanceSpec): Promise<Catalogs | null> {
    try {
      const stored = record(await this.kv.get(spec.runtimeId, KEY))
      return stored?.specKey === specKey(spec) ? record(stored.catalogs) : null
    } catch {
      return null
    }
  }

  /**
   * The instance's live catalogs, with each kind it lists nothing for taken from the remembered ones. Live
   * catalogs that list models are remembered.
   */
  public async fill(spec: RuntimeInstanceSpec, live: Catalogs | null): Promise<Catalogs | null> {
    if (hasModels(live)) {
      await this.remember(spec, live)
      return live
    }
    const recalled = await this.recall(spec)
    if (recalled === null) return live
    const filled: Catalogs = { ...recalled, ...(live ?? {}) }
    for (const kind of Object.keys(ITEMS)) if (!hasItems(live, kind) && hasItems(recalled, kind)) filled[kind] = recalled[kind]
    return filled
  }
}
