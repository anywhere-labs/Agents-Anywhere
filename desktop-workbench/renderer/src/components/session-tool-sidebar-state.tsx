"use client"

import * as React from "react"

import {
  createSessionToolSidebarStore,
  type SessionToolSidebarContext,
  type SessionToolSidebarHostBounds,
  type SessionToolSidebarStore,
} from "@/components/session-tool-sidebar-store"
import { useAuth } from "@/components/auth/auth-context"
import { INITIAL_SESSION_TOOL_TABS_STATE } from "@/components/session-tool-tabs"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"

const SessionToolSidebarStateContext = React.createContext<SessionToolSidebarStore | null>(null)

export function SessionToolSidebarStateProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth()
  const [store] = React.useState(createSessionToolSidebarStore)
  const sessionRef = React.useRef(session)
  sessionRef.current = session

  React.useEffect(() => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.lifecycle || !session) return

    void bridge.lifecycle.updateTerminalAuth?.({
      userId: session.userId,
      token: session.accessToken,
    })
  }, [session])

  React.useEffect(() => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.lifecycle) return

    return bridge.lifecycle.onBeforeQuit(async () => {
      store.beginShutdown()
      try {
        const currentSession = sessionRef.current
        if (currentSession) {
          await bridge.lifecycle?.updateTerminalAuth?.({
            userId: currentSession.userId,
            token: currentSession.accessToken,
          })
        }
      } finally {
        await store.waitForTerminalTasks()
      }
    })
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

export function updateSessionToolSidebarHostBounds(
  store: SessionToolSidebarStore,
  bounds: SessionToolSidebarHostBounds,
) {
  store.setHostBounds(bounds)
}
