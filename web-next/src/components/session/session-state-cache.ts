import type {
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
}

export type CachedSessionState = {
  state: SessionRemoteState
  hasSnapshot: boolean
  scrollTop: number
  following: boolean
  groupOpen: Record<string, boolean>
  itemOpen: Record<string, boolean>
}

/** In-memory only. A workspace creates a separate cache for each account/server. */
export function createSessionStateCache(scope: string, options: {
  maxEntries?: number
  maxBytes?: number
} = {}) {
  const maxEntries = options.maxEntries ?? 5
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  const entries = new Map<string, { value: CachedSessionState; bytes: number }>()
  let bytes = 0
  const remove = (sessionId: string) => {
    const entry = entries.get(sessionId)
    if (entry) bytes -= entry.bytes
    entries.delete(sessionId)
  }
  return {
    scope,
    get(sessionId: string): CachedSessionState | null {
      const entry = entries.get(sessionId)
      if (!entry) return null
      entries.delete(sessionId)
      entries.set(sessionId, entry)
      return entry.value
    },
    set(sessionId: string, value: CachedSessionState): void {
      remove(sessionId)
      if (value.state.session.id !== sessionId) return
      // Estimate retained string storage once on leaving a session, never on
      // each streaming revision. Oversized histories must not pin the cache.
      const size = JSON.stringify(value).length * 2
      if (size > maxBytes || maxEntries <= 0) return
      entries.set(sessionId, { value, bytes: size })
      bytes += size
      while (entries.size > maxEntries || bytes > maxBytes) {
        remove(entries.keys().next().value!)
      }
    },
    delete: remove,
  }
}

export type SessionStateCache = ReturnType<typeof createSessionStateCache>
