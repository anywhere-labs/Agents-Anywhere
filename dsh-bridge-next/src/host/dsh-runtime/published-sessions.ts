import { readJson, writeJson } from '../storage/files.js'

type Stored = { version: 1, namespaces: Record<string, string[]> }

/**
 * The sessions this Host published, per namespace, kept across restarts. Only
 * that record tells a session DSH deleted (absent from a fresh inventory) from
 * one this Host never saw; without it every restart would forget the deletion.
 * It is a memory of what was published, never a second session store.
 */
export class PublishedSessions {
  private namespaces = new Map<string, Set<string>>()
  private loading: Promise<void> | undefined
  private writes: Promise<void> = Promise.resolve()

  /** Without a path the record lives and dies with the process. */
  constructor(private readonly path?: string) {}

  private async load(): Promise<void> {
    if (!this.path) return
    let stored: Stored | null = null
    try { stored = await readJson<Stored>(this.path) } catch { stored = null }
    if (stored?.version !== 1) return
    for (const [namespace, ids] of Object.entries(stored.namespaces)) {
      if (!Array.isArray(ids)) continue
      this.namespaces.set(namespace, new Set(ids.filter((id): id is string => typeof id === 'string')))
    }
  }
  private async settled(): Promise<void> { this.loading ??= this.load(); await this.loading }
  private set(namespace: string): Set<string> {
    let ids = this.namespaces.get(namespace)
    if (!ids) this.namespaces.set(namespace, ids = new Set())
    return ids
  }
  async add(namespace: string, id: string): Promise<void> {
    await this.settled()
    if (this.set(namespace).has(id)) return
    this.set(namespace).add(id)
    await this.save()
  }
  async remove(namespace: string, id: string): Promise<void> {
    await this.settled()
    if (!this.set(namespace).delete(id)) return
    await this.save()
  }
  async ids(namespace: string): Promise<readonly string[]> {
    await this.settled()
    return [...this.set(namespace)]
  }
  /** Writers queue behind one another; a failed write must not block the next. */
  private async save(): Promise<void> {
    if (!this.path) return
    const value: Stored = { version: 1, namespaces: Object.fromEntries([...this.namespaces].map(([ns, ids]) => [ns, [...ids]])) }
    const write = this.writes.then(() => writeJson(this.path!, value))
    this.writes = write.catch(() => {})
    await write
  }
}
