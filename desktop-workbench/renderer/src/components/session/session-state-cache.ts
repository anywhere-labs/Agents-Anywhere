import { SESSION_DISK_RECORD_VERSION, sessionScopeEpoch, type PersistentSessionStore } from "./session-disk-store"
import type {
  HistorySource,
  Notice,
  ProtocolCapabilitySet,
  ProtocolModelCatalog,
  ProtocolPermissionCatalog,
  SessionRuntimeState,
  SessionView,
  TimelineItem,
} from "@/features/dashboard/types"

export type SessionRemoteState = {
  session: SessionView
  state?: SessionRuntimeState | null
  items: TimelineItem[]
  notices: Notice[]
  nextSeq: number
  hasMore: boolean
  timelineResetVersion: number
  serverTime: string
  eventCursor: string
  effectiveCapabilities: ProtocolCapabilitySet | null
  catalogs: {
    model?: ProtocolModelCatalog
    permission?: ProtocolPermissionCatalog
    [key: string]: unknown
  }
  /**
   * Protocol 1.2: the device holding this session's history is offline. The
   * items are whatever this client loaded earlier, not a complete page.
   */
  deviceOffline?: boolean
  historySource?: HistorySource
}

export type CachedSessionState = {
  state: SessionRemoteState
  hasSnapshot: boolean
  scrollTop: number
  following: boolean
  groupOpen: Record<string, boolean>
  itemOpen: Record<string, boolean>
}

/** The cache scope of one account on one server: caches never cross it. */
export function sessionCacheScope(server: string, userId: string | null | undefined): string {
  return JSON.stringify([server, userId ?? null])
}

/**
 * Content saved to disk: data and reading position only. Runtime facts,
 * notices and local optimistic messages are live state that a later visit
 * must read again, so they never outlive the process.
 */
export function persistableSessionState(value: CachedSessionState): CachedSessionState {
  const items = value.state.items.filter(
    (item) => !item.id.startsWith("optimistic-message:") && item.source?.optimistic !== true,
  )
  return {
    ...value,
    state: { ...value.state, items, state: null, notices: [], deviceOffline: undefined, historySource: undefined },
  }
}

/**
 * Memory LRU for switching sessions, optionally backed by a disk store so a
 * reload or an offline device still shows what this client loaded before.
 * A workspace creates a separate cache for each account/server.
 */
export function createSessionStateCache(scope: string, options: {
  maxEntries?: number
  maxBytes?: number
  persistent?: PersistentSessionStore | null
  maxDiskEntries?: number
  maxDiskBytes?: number
  now?: () => number
} = {}) {
  const maxEntries = options.maxEntries ?? 5
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  const persistent = options.persistent ?? null
  const maxDiskEntries = options.maxDiskEntries ?? 50
  const maxDiskBytes = options.maxDiskBytes ?? 64 * 1024 * 1024
  const now = options.now ?? Date.now
  const entries = new Map<string, { value: CachedSessionState; bytes: number }>()
  // Deletions win over writes still in flight for the same session.
  const generations = new Map<string, number>()
  let cleared = 0
  const epoch = sessionScopeEpoch(scope)
  const forgotten = () => sessionScopeEpoch(scope) !== epoch
  let bytes = 0
  const remove = (sessionId: string) => {
    const entry = entries.get(sessionId)
    if (entry) bytes -= entry.bytes
    entries.delete(sessionId)
  }
  const remember = (sessionId: string, value: CachedSessionState, size: number) => {
    remove(sessionId)
    if (size > maxBytes || maxEntries <= 0) return
    entries.set(sessionId, { value, bytes: size })
    bytes += size
    while (entries.size > maxEntries || bytes > maxBytes) {
      remove(entries.keys().next().value!)
    }
  }
  async function prune() {
    if (!persistent) return
    const records = (await persistent.list(scope)).sort((a, b) => b.accessedAt - a.accessedAt)
    let total = 0
    for (const [index, record] of records.entries()) {
      total += record.bytes
      if (index >= maxDiskEntries || total > maxDiskBytes) await persistent.delete(scope, record.sessionId)
    }
  }
  let writes: Promise<void> = Promise.resolve()
  function persist(sessionId: string, value: CachedSessionState) {
    if (!persistent || forgotten() || value.state.session.id !== sessionId || !value.hasSnapshot) return writes
    const generation = generations.get(sessionId) ?? 0
    const clearedAt = cleared
    const stored = persistableSessionState(value)
    const size = JSON.stringify(stored).length * 2
    if (size > maxDiskBytes) return writes
    writes = writes.then(async () => {
      if ((generations.get(sessionId) ?? 0) !== generation || cleared !== clearedAt || forgotten()) return
      await persistent.write({
        scope, sessionId, version: SESSION_DISK_RECORD_VERSION, accessedAt: now(), bytes: size, value: stored,
      })
      await prune()
    })
    return writes
  }
  return {
    scope,
    persistent: Boolean(persistent),
    has(sessionId: string): boolean {
      return entries.has(sessionId)
    },
    get(sessionId: string): CachedSessionState | null {
      const entry = entries.get(sessionId)
      if (!entry) return null
      entries.delete(sessionId)
      entries.set(sessionId, entry)
      return entry.value
    },
    /** Memory first, then disk. A disk hit is kept in memory for this visit. */
    async load(sessionId: string): Promise<CachedSessionState | null> {
      const memory = entries.get(sessionId)
      if (memory || !persistent) return memory?.value ?? null
      const generation = generations.get(sessionId) ?? 0
      const clearedAt = cleared
      const record = await persistent.read(scope, sessionId)
      if ((generations.get(sessionId) ?? 0) !== generation || cleared !== clearedAt) return entries.get(sessionId)?.value ?? null
      if (!record || record.version !== SESSION_DISK_RECORD_VERSION || record.scope !== scope ||
          record.value?.state?.session?.id !== sessionId) return entries.get(sessionId)?.value ?? null
      if (!entries.has(sessionId)) remember(sessionId, record.value, record.bytes)
      return entries.get(sessionId)?.value ?? null
    },
    set(sessionId: string, value: CachedSessionState): void {
      remove(sessionId)
      if (value.state.session.id !== sessionId) return
      // Estimate retained string storage once on leaving a session, never on
      // each streaming revision. Oversized histories must not pin the cache.
      const size = JSON.stringify(value).length * 2
      remember(sessionId, value, size)
      void persist(sessionId, value)
    },
    /** Saves the current visit to disk without changing the memory LRU. */
    save(sessionId: string, value: CachedSessionState): Promise<void> {
      return persist(sessionId, value)
    },
    delete(sessionId: string): void {
      remove(sessionId)
      generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1)
      if (persistent) writes = writes.then(() => persistent.delete(scope, sessionId))
    },
    /** Forgets every session of this account/server, in memory and on disk. */
    clear(): Promise<void> {
      entries.clear()
      bytes = 0
      cleared++
      if (persistent) writes = writes.then(() => persistent.clearScope(scope))
      return writes
    },
    /** Resolves when queued disk writes have finished. */
    flush(): Promise<void> {
      return writes
    },
  }
}

export type SessionStateCache = ReturnType<typeof createSessionStateCache>
