"use client"

import * as React from "react"

import {
  createSessionToolSidebarStore,
  type SessionReviewTimelineSnapshot,
  type SessionToolSidebarContext,
  type SessionToolSidebarHostBounds,
  type SessionToolSidebarStore,
} from "@/components/session-tool-sidebar-store"
import { useAuth } from "@/components/auth/auth-context"
import { INITIAL_SESSION_TOOL_TABS_STATE } from "@/components/session-tool-tabs"
import { API_NAMESPACE } from "@/lib/api"
import { readTerminalPreferences, terminalPreferenceKey, writeTerminalPreferences } from "./session-terminal-preferences"

const SessionToolSidebarStateContext = React.createContext<SessionToolSidebarStore | null>(null)

export function SessionToolSidebarStateProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth()
  const [store] = React.useState(() => {
    let storage: Storage | null = null
    try {
      if (typeof window !== "undefined") storage = window.localStorage
    } catch { /* Browser storage may be disabled. Inventory queries remain available. */ }
    const server = JSON.stringify([process.env.NEXT_PUBLIC_AGENTS_ANYWHERE_API ?? "", API_NAMESPACE])
    const key = terminalPreferenceKey(server, session?.userId ?? "signed-out")
    return createSessionToolSidebarStore({
      terminalPreferences: readTerminalPreferences(storage, key),
      onTerminalPreferencesChange: (preferences) => writeTerminalPreferences(storage, key, preferences),
    })
  })

  const lifecycleGeneration = React.useRef(0)
  React.useEffect(() => {
    const generation = ++lifecycleGeneration.current
    return () => {
      queueMicrotask(() => {
        if (lifecycleGeneration.current !== generation) return
        store.beginShutdown()
      })
    }
  }, [store])

  return (
    <SessionToolSidebarStateContext.Provider value={store}>
      {children}
    </SessionToolSidebarStateContext.Provider>
  )
}

export function useSessionToolSidebarStore() {
  const store = React.useContext(SessionToolSidebarStateContext)
  if (!store) {
    throw new Error("useSessionToolSidebarStore must be used within SessionToolSidebarStateProvider")
  }
  return store
}

export function useStoredSessionToolSidebarState(sessionId: string | null) {
  const store = useSessionToolSidebarStore()
  const subscribe = React.useCallback(
    (listener: () => void) => sessionId ? store.subscribeState(sessionId, listener) : () => undefined,
    [sessionId, store],
  )
  const getSnapshot = React.useCallback(
    () => sessionId ? store.getState(sessionId) : INITIAL_SESSION_TOOL_TABS_STATE,
    [sessionId, store],
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useStoredSessionToolSidebarContext(sessionId: string) {
  const store = useSessionToolSidebarStore()
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribeContext(sessionId, listener),
    [sessionId, store],
  )
  const getSnapshot = React.useCallback(() => store.getContext(sessionId), [sessionId, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useStoredSessionReviewTimeline(sessionId: string) {
  const store = useSessionToolSidebarStore()
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribeReviewTimeline(sessionId, listener),
    [sessionId, store],
  )
  const getSnapshot = React.useCallback(
    () => store.getReviewTimeline(sessionId),
    [sessionId, store],
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useStoredSessionToolSidebarIds() {
  const store = useSessionToolSidebarStore()
  return React.useSyncExternalStore(
    store.subscribeSessionIds,
    store.getSessionIds,
    store.getSessionIds,
  )
}

export function useSessionToolSidebarHostBounds() {
  const store = useSessionToolSidebarStore()
  return React.useSyncExternalStore(
    store.subscribeHostBounds,
    store.getHostBounds,
    store.getHostBounds,
  )
}

export function registerSessionToolSidebarContext(
  store: SessionToolSidebarStore,
  sessionId: string,
  context: SessionToolSidebarContext,
) {
  store.setContext(sessionId, context)
}

export function updateSessionReviewTimeline(
  store: SessionToolSidebarStore,
  sessionId: string,
  snapshot: SessionReviewTimelineSnapshot | null,
) {
  store.setReviewTimeline(sessionId, snapshot)
}

export function updateSessionToolSidebarHostBounds(
  store: SessionToolSidebarStore,
  bounds: SessionToolSidebarHostBounds,
) {
  store.setHostBounds(bounds)
}
