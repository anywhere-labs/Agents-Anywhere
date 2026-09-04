import {
  INITIAL_SESSION_TOOL_TABS_STATE,
  sessionToolTabsReducer,
  type SessionToolTabsAction,
  type SessionToolTabsState,
} from "./session-tool-tabs.ts"

export type SessionToolSidebarContext = {
  ownerUserId: string
  connectorId: string | null
  connectorDeviceOs?: string | null
  root: string
  terminalLabel: string
}

export type SessionToolSidebarHostBounds = {
  left: number
  width: number
}

type Listener = () => void

export type SessionToolSidebarStore = ReturnType<typeof createSessionToolSidebarStore>

export function createSessionToolSidebarStore() {
  const states = new Map<string, SessionToolTabsState>()
  const contexts = new Map<string, SessionToolSidebarContext>()
  const aliases = new Map<string, string>()
  const hostKeys = new Map<string, string>()
  const stateListeners = new Map<string, Set<Listener>>()
  const contextListeners = new Map<string, Set<Listener>>()
  const sessionIdsListeners = new Set<Listener>()
  const hostBoundsListeners = new Set<Listener>()
  const terminalTasks = new Set<Promise<unknown>>()
  let sessionIdsSnapshot: string[] = []
  let hostBounds: SessionToolSidebarHostBounds = { left: 0, width: 0 }
  let shuttingDown = false

  const resolveSessionId = (sessionId: string) => {
    let current = sessionId
    const visited = new Set<string>()
    while (aliases.has(current) && !visited.has(current)) {
      visited.add(current)
      current = aliases.get(current) ?? current
    }
    return current
  }

  const addSessionId = (sessionId: string) => {
    sessionId = resolveSessionId(sessionId)
    if (sessionIdsSnapshot.includes(sessionId)) return
    if (!hostKeys.has(sessionId)) hostKeys.set(sessionId, sessionId)
    sessionIdsSnapshot = [...sessionIdsSnapshot, sessionId]
    sessionIdsListeners.forEach((listener) => listener())
  }

  const subscribeToMap = (
    listeners: Map<string, Set<Listener>>,
    sessionId: string,
    listener: Listener,
  ) => {
    const current = listeners.get(sessionId) ?? new Set<Listener>()
    current.add(listener)
    listeners.set(sessionId, current)
    return () => {
      current.delete(listener)
      if (current.size === 0) listeners.delete(sessionId)
    }
  }

  return {
    getState(sessionId: string): SessionToolTabsState {
      return states.get(resolveSessionId(sessionId)) ?? INITIAL_SESSION_TOOL_TABS_STATE
    },

    dispatch(sessionId: string, action: SessionToolTabsAction) {
      sessionId = resolveSessionId(sessionId)
      const current = states.get(sessionId) ?? INITIAL_SESSION_TOOL_TABS_STATE
      const next = sessionToolTabsReducer(current, action)
      if (next === current) return
      states.set(sessionId, next)
      addSessionId(sessionId)
      stateListeners.get(sessionId)?.forEach((listener) => listener())
    },

    subscribeState(sessionId: string, listener: Listener) {
      return subscribeToMap(stateListeners, resolveSessionId(sessionId), listener)
    },

    getContext(sessionId: string): SessionToolSidebarContext | null {
      return contexts.get(resolveSessionId(sessionId)) ?? null
    },

    setContext(sessionId: string, context: SessionToolSidebarContext) {
      sessionId = resolveSessionId(sessionId)
      const current = contexts.get(sessionId)
      if (current && sameContext(current, context)) return
      contexts.set(sessionId, context)
      addSessionId(sessionId)
      contextListeners.get(sessionId)?.forEach((listener) => listener())
    },

    subscribeContext(sessionId: string, listener: Listener) {
      return subscribeToMap(contextListeners, resolveSessionId(sessionId), listener)
    },

    migrateSession(fromSessionId: string, toSessionId: string) {
      const from = resolveSessionId(fromSessionId)
      const to = resolveSessionId(toSessionId)
      if (from === to) return
      const fromStateListeners = stateListeners.get(from)
      const fromContextListeners = contextListeners.get(from)

      const fromState = states.get(from)
      const toState = states.get(to)
      if (fromState) states.set(to, mergeSessionStates(toState, fromState))
      states.delete(from)

      const fromHostKey = hostKeys.get(from) ?? from
      if (!hostKeys.has(to)) hostKeys.set(to, fromHostKey)
      hostKeys.delete(from)

      const fromContext = contexts.get(from)
      if (fromContext && !contexts.has(to)) contexts.set(to, fromContext)
      contexts.delete(from)

      aliases.set(fromSessionId, to)
      aliases.set(from, to)
      sessionIdsSnapshot = Array.from(new Set(
        sessionIdsSnapshot.map((sessionId) => sessionId === from ? to : resolveSessionId(sessionId)),
      ))
      fromStateListeners?.forEach((listener) => listener())
      fromContextListeners?.forEach((listener) => listener())
      stateListeners.get(to)?.forEach((listener) => listener())
      contextListeners.get(to)?.forEach((listener) => listener())
      sessionIdsListeners.forEach((listener) => listener())
    },

    getSessionIds(): string[] {
      return sessionIdsSnapshot
    },

    getHostKey(sessionId: string): string {
      const resolved = resolveSessionId(sessionId)
      return hostKeys.get(resolved) ?? resolved
    },

    subscribeSessionIds(listener: Listener) {
      sessionIdsListeners.add(listener)
      return () => sessionIdsListeners.delete(listener)
    },

    getHostBounds(): SessionToolSidebarHostBounds {
      return hostBounds
    },

    setHostBounds(next: SessionToolSidebarHostBounds) {
      if (hostBounds.left === next.left && hostBounds.width === next.width) return
      hostBounds = next
      hostBoundsListeners.forEach((listener) => listener())
    },

    subscribeHostBounds(listener: Listener) {
      hostBoundsListeners.add(listener)
      return () => hostBoundsListeners.delete(listener)
    },

    trackTerminalTask<T>(task: Promise<T>): Promise<T> {
      terminalTasks.add(task)
      void task.finally(() => terminalTasks.delete(task)).catch(() => undefined)
      return task
    },

    async waitForTerminalTasks(): Promise<void> {
      while (terminalTasks.size > 0) {
        await Promise.allSettled(Array.from(terminalTasks))
      }
    },

    beginShutdown() {
      shuttingDown = true
    },

    isShuttingDown() {
      return shuttingDown
    },
  }
}

function mergeSessionStates(
  target: SessionToolTabsState | undefined,
  source: SessionToolTabsState,
): SessionToolTabsState {
  if (!target) return source
  const sourceIds = new Set(source.tabs.map((tab) => tab.id))
  return {
    ...source,
    open: source.open || target.open,
    tabs: [...target.tabs.filter((tab) => !sourceIds.has(tab.id)), ...source.tabs],
    activeTabId: source.activeTabId ?? target.activeTabId,
  }
}

function sameContext(a: SessionToolSidebarContext, b: SessionToolSidebarContext) {
  return (
    a.connectorId === b.connectorId &&
    a.ownerUserId === b.ownerUserId &&
    a.connectorDeviceOs === b.connectorDeviceOs &&
    a.root === b.root &&
    a.terminalLabel === b.terminalLabel
  )
}
