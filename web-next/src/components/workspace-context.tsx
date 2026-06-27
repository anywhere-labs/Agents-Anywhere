"use client"

import * as React from "react"
import {
  defaultFilter,
  listConnectors as listMockConnectors,
  listSessions as listMockSessions,
  patchSession as patchMockSession,
  type ConnectorView,
  type FilterValue,
  type SessionView,
} from "@/lib/demo-api"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import type {
  ConnectorView as RealConnectorView,
  SessionView as RealSessionView,
} from "@/features/dashboard/types"

// ─── Panel / page types ───────────────────────────────────────

export type PanelId = "files" | "terminal"
export type PanelMode = "docked" | "floating" | "closed"

/**
 * Page names that map to hash routes:
 *   home                         →  #/
 *   session/:id                  →  #/session/s1
 *   settings/:tab                →  #/settings/account
 *   team                         →  #/team
 *   service                      →  #/service
 *   device/:id                   →  #/device/conn-3
 *   device/:id/workspace/:path   →  #/device/conn-3/workspace/~path~
 */
export type AppPage = "home" | "session" | "settings" | "team" | "service" | "device" | "device-workspace"

// ─── Hash routing helpers ─────────────────────────────────────

type ParsedRoute =
  | { page: "home" }
  | { page: "session"; sessionId: string }
  | { page: "settings"; tab: string }
  | { page: "team" }
  | { page: "service" }
  | { page: "device"; connectorId: string }
  | { page: "device-workspace"; connectorId: string; workspacePath: string }

/** Encode a file path for use in a URL hash segment */
function encodePath(p: string) { return encodeURIComponent(p) }
function decodePath(p: string) { return decodeURIComponent(p) }

function parseHash(hash: string): ParsedRoute {
  const path = hash.replace(/^#\/?/, "")
  if (!path || path === "/") return { page: "home" }

  const parts = path.split("/")
  switch (parts[0]) {
    case "session":
      return parts[1] ? { page: "session", sessionId: parts[1] } : { page: "home" }
    case "settings":
      return { page: "settings", tab: parts[1] ?? "account" }
    case "team":
      return { page: "team" }
    case "service":
      return { page: "service" }
    case "device": {
      const connectorId = parts[1]
      if (!connectorId) return { page: "home" }
      if (parts[2] === "workspace" && parts[3]) {
        return { page: "device-workspace", connectorId, workspacePath: decodePath(parts.slice(3).join("/")) }
      }
      return { page: "device", connectorId }
    }
    default:
      return { page: "home" }
  }
}

function buildHash(route: ParsedRoute): string {
  switch (route.page) {
    case "home":      return "#/"
    case "session":   return `#/session/${route.sessionId}`
    case "settings":  return `#/settings/${route.tab}`
    case "team":      return "#/team"
    case "service":   return "#/service"
    case "device":    return `#/device/${route.connectorId}`
    case "device-workspace":
      return `#/device/${route.connectorId}/workspace/${encodePath(route.workspacePath)}`
  }
}

function mapConnector(connector: RealConnectorView): ConnectorView {
  return {
    id: connector.id,
    userId: connector.userId,
    name: connector.name,
    status: connector.status,
    lastSeenAt: connector.lastSeenAt,
    runtimeCapabilities: connector.runtimeCapabilities,
  }
}

function mapSession(session: RealSessionView): SessionView {
  return {
    id: session.id,
    connectorId: session.connectorId,
    connectorStatus: session.connectorStatus,
    runtime: runtimeLabel(session.runtime),
    title: session.title || "Untitled session",
    cwd: session.cwd,
    status: session.status,
    takeover: session.takeover,
    pinned: session.pinned,
    archived: session.archived,
    unread: session.unread,
    lastReadSeq: session.lastReadSeq,
    updatedSeq: session.updatedSeq,
    effectiveRunMode: session.effectiveRunMode,
    runtimeSettings: session.runtimeSettings ?? null,
    updatedAt: relativeSessionTime(session),
  }
}

function runtimeLabel(runtime: string): string {
  if (runtime === "codex") return "Codex"
  if (runtime === "claude") return "Claude"
  if (runtime === "opencode") return "OpenCode"
  if (runtime === "cursor") return "Cursor"
  return runtime.slice(0, 1).toUpperCase() + runtime.slice(1)
}

function relativeSessionTime(session: RealSessionView): string {
  const raw =
    session.sortAt ||
    session.lastActivityAt ||
    session.lastItemAt ||
    session.lastSyncedAt ||
    session.sourceObservedAt
  if (!raw) return ""
  const timestamp = Date.parse(raw)
  if (!Number.isFinite(timestamp)) return ""
  const diff = Date.now() - timestamp
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

// ─── Context shape ────────────────────────────────────────────

type WorkspaceState = {
  // Data from API
  connectors: ConnectorView[]
  sessions: SessionView[]
  isLoading: boolean
  routeReady: boolean

  // Navigation
  page: AppPage
  activeSessionId: string | null
  activeConnectorId: string | null
  activeWorkspacePath: string | null
  settingsTab: string

  // Sidebar filter/search
  filter: FilterValue
  search: string

  // Panels
  panels: Record<PanelId, PanelMode>
  collapsed: Record<PanelId, boolean>
  popupBlocked: boolean
  firstDevicePromptOpen: boolean
  pairDeviceDialogOpen: boolean

  // Actions
  openSession: (id: string) => void
  goHome: () => void
  navigate: (page: AppPage, sub?: string) => void
  navigateToDevice: (connectorId: string) => void
  navigateToWorkspace: (connectorId: string, workspacePath: string) => void
  setFilter: (f: FilterValue) => void
  setSearch: (q: string) => void
  setPanelMode: (id: PanelId, mode: PanelMode) => void
  toggleCollapse: (id: PanelId) => void
  dismissPopupBlocked: () => void
  openPairDeviceDialog: () => void
  closePairDeviceDialog: () => void
  closeFirstDevicePrompt: () => void
  togglePinSession: (id: string) => void
  toggleArchiveSession: (id: string) => void
  markSessionRead: (id: string) => void
  upsertSession: (session: RealSessionView) => void
  refreshData: () => void
}

const WorkspaceContext = React.createContext<WorkspaceState | null>(null)

const FIRST_DEVICE_WIZARD_DISMISSED_KEY = "aa-first-device-wizard-dismissed-v1"

export function useWorkspace() {
  const ctx = React.useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}

// ─── Provider ─────────────────────────────────────────────────

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { session: authSession } = useAuth()
  const [connectors, setConnectors] = React.useState<ConnectorView[]>([])
  const [sessions, setSessions] = React.useState<SessionView[]>([])
  const [isLoading, setIsLoading] = React.useState(true)

  // Derive page state from hash — start at "home" for safe SSR, correct on mount.
  const [route, setRoute] = React.useState<ParsedRoute>({ page: "home" })
  const [routeReady, setRouteReady] = React.useState(false)

  const [filter, setFilter] = React.useState<FilterValue>(defaultFilter)
  const [search, setSearch] = React.useState("")
  const [panels, setPanels] = React.useState<Record<PanelId, PanelMode>>({
    files: "docked",
    terminal: "docked",
  })
  const [collapsed, setCollapsed] = React.useState<Record<PanelId, boolean>>({
    files: false,
    terminal: false,
  })
  const [popupBlocked, setPopupBlocked] = React.useState(false)
  const [firstDevicePromptOpen, setFirstDevicePromptOpen] = React.useState(false)
  const [pairDeviceDialogOpen, setPairDeviceDialogOpen] = React.useState(false)
  const firstDeviceWizardCheckedRef = React.useRef(false)

  // ── Fetch data from mock API ──────────────────────────────
  const initialLoadDoneRef = React.useRef(false)

  const fetchData = React.useCallback(async () => {
    if (!initialLoadDoneRef.current) {
      setIsLoading(true)
    }
    try {
      if (authSession?.accessToken) {
        const [connRes, sessRes] = await Promise.all([
          dashboardApi.listConnectors(authSession.accessToken),
          dashboardApi.listSessions(authSession.accessToken),
        ])
        setConnectors(connRes.connectors.map(mapConnector))
        setSessions(sessRes.sessions.map(mapSession))
        return
      }
      const [connRes, sessRes] = await Promise.all([
        listMockConnectors("mock-token"),
        listMockSessions("mock-token"),
      ])
      setConnectors(connRes.connectors)
      setSessions(sessRes.sessions)
    } finally {
      setIsLoading(false)
      initialLoadDoneRef.current = true
    }
  }, [authSession?.accessToken])

  React.useEffect(() => {
    initialLoadDoneRef.current = false
  }, [authSession?.accessToken])

  React.useEffect(() => {
    fetchData()
  }, [fetchData])

  // ── Dashboard SSE + polling ────────────────────────────────
  const tokenRef = React.useRef(authSession?.accessToken ?? null)
  tokenRef.current = authSession?.accessToken ?? null

  React.useEffect(() => {
    if (!authSession?.accessToken) return
    let cancelled = false
    let eventSource: EventSource | null = null
    let pollTimer: number | null = null

    const refetch = () => {
      if (cancelled) return
      fetchData()
    }

    // SSE for real-time dashboard updates
    try {
      eventSource = new EventSource(dashboardApi.dashboardEventsUrl(authSession.accessToken))
      eventSource.onmessage = (event) => {
        if (cancelled || !event.data) return
        try {
          const msg = JSON.parse(event.data) as { type?: string }
          if (msg.type === "dashboard.changed" || msg.type === "dashboard.sync") {
            refetch()
          }
        } catch { /* ignore malformed */ }
      }
      eventSource.onerror = () => {
        eventSource?.close()
        eventSource = null
      }
    } catch { /* SSE unavailable */ }

    // Fallback polling when SSE is disconnected
    pollTimer = window.setInterval(() => {
      if (cancelled) return
      if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
        refetch()
      }
    }, 30_000)

    return () => {
      cancelled = true
      eventSource?.close()
      if (pollTimer !== null) window.clearInterval(pollTimer)
    }
  }, [authSession?.accessToken, fetchData])

  // ── Hash routing ──────────────────────────────────────────
  React.useEffect(() => {
    // Correct from hash immediately on mount, then keep in sync.
    setRoute(parseHash(window.location.hash))
    setRouteReady(true)
    const handler = () => React.startTransition(() => setRoute(parseHash(window.location.hash)))
    window.addEventListener("hashchange", handler)
    return () => window.removeEventListener("hashchange", handler)
  }, [])

  const pushRoute = React.useCallback((r: ParsedRoute) => {
    window.location.hash = buildHash(r)
    React.startTransition(() => setRoute(r))
  }, [])

  // ── Navigation helpers ────────────────────────────────────

  const markSessionRead = React.useCallback((id: string) => {
    const targetSession = sessions.find((session) => session.id === id)
    if (!targetSession || !targetSession.unread) return

    setSessions((prev) =>
      prev.map((session) =>
        session.id === id
          ? { ...session, unread: false, lastReadSeq: Math.max(session.lastReadSeq, session.updatedSeq) }
          : session,
      ),
    )

    if (!authSession?.accessToken) return
    dashboardApi
      .markSessionRead(authSession.accessToken, id)
      .then((response) => {
        const mapped = mapSession(response.session)
        setSessions((prev) => {
          const index = prev.findIndex((item) => item.id === mapped.id)
          if (index === -1) return [mapped, ...prev]
          const next = [...prev]
          next[index] = mapped
          return next
        })
      })
      .catch(() => {
        fetchData()
      })
  }, [authSession?.accessToken, fetchData, sessions])

  const openSession = React.useCallback(
    (id: string) => {
      markSessionRead(id)
      pushRoute({ page: "session", sessionId: id })
    },
    [markSessionRead, pushRoute],
  )

  const goHome = React.useCallback(() => pushRoute({ page: "home" }), [pushRoute])

  const navigate = React.useCallback(
    (page: AppPage, sub?: string) => {
      if (page === "home") pushRoute({ page: "home" })
      else if (page === "session") pushRoute({ page: "session", sessionId: sub ?? "" })
      else if (page === "settings") pushRoute({ page: "settings", tab: sub ?? "account" })
      else if (page === "team") pushRoute({ page: "team" })
      else if (page === "service") pushRoute({ page: "service" })
    },
    [pushRoute],
  )

  const navigateToDevice = React.useCallback(
    (connectorId: string) => pushRoute({ page: "device", connectorId }),
    [pushRoute],
  )

  const navigateToWorkspace = React.useCallback(
    (connectorId: string, workspacePath: string) =>
      pushRoute({ page: "device-workspace", connectorId, workspacePath }),
    [pushRoute],
  )

  // ── Panel helpers ─────────────────────────────────────────

  const setPanelMode = React.useCallback((id: PanelId, mode: PanelMode) => {
    setPanels((prev) => ({ ...prev, [id]: mode }))
    if (mode !== "closed") setCollapsed((prev) => ({ ...prev, [id]: false }))
  }, [])

  const toggleCollapse = React.useCallback((id: PanelId) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const dismissPopupBlocked = React.useCallback(() => setPopupBlocked(false), [])

  const openPairDeviceDialog = React.useCallback(() => {
    setFirstDevicePromptOpen(false)
    setPairDeviceDialogOpen(true)
  }, [])

  const closePairDeviceDialog = React.useCallback(() => {
    setPairDeviceDialogOpen(false)
  }, [])

  const closeFirstDevicePrompt = React.useCallback(() => {
    setFirstDevicePromptOpen(false)
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(FIRST_DEVICE_WIZARD_DISMISSED_KEY, "1")
    }
  }, [])

  React.useEffect(() => {
    if (!routeReady || isLoading || route.page !== "home" || firstDeviceWizardCheckedRef.current) return
    if (connectors.length > 0) {
      firstDeviceWizardCheckedRef.current = true
      return
    }
    firstDeviceWizardCheckedRef.current = true
    if (typeof window !== "undefined" && window.sessionStorage.getItem(FIRST_DEVICE_WIZARD_DISMISSED_KEY) === "1") {
      return
    }
    setFirstDevicePromptOpen(true)
  }, [connectors.length, isLoading, route.page, routeReady])

  // ── Session optimistic patch helpers ──────────────────────

  const togglePinSession = React.useCallback(async (id: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s)),
    )
    const targetSession = sessions.find((s) => s.id === id)
    if (targetSession) {
      if (authSession?.accessToken) {
        await dashboardApi.patchSession(authSession.accessToken, id, { pinned: !targetSession.pinned })
      } else {
        await patchMockSession("mock-token", id, { pinned: !targetSession.pinned })
      }
    }
  }, [authSession?.accessToken, sessions])

  const toggleArchiveSession = React.useCallback(async (id: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, archived: !s.archived } : s)),
    )
    const targetSession = sessions.find((s) => s.id === id)
    if (targetSession) {
      if (authSession?.accessToken) {
        await dashboardApi.patchSession(authSession.accessToken, id, { archived: !targetSession.archived })
      } else {
        await patchMockSession("mock-token", id, { archived: !targetSession.archived })
      }
    }
  }, [authSession?.accessToken, sessions])

  const upsertSession = React.useCallback((session: RealSessionView) => {
    const mapped = mapSession(session)
    setSessions((prev) => {
      const index = prev.findIndex((item) => item.id === mapped.id)
      if (index === -1) return [mapped, ...prev]
      const next = [...prev]
      next[index] = mapped
      return next
    })
  }, [])

  // ── Derived route fields ──────────────────────────────────

  const validPages: AppPage[] = ["home", "session", "settings", "team", "service", "device", "device-workspace"]
  const page: AppPage = validPages.includes(route.page as AppPage) ? (route.page as AppPage) : "home"

  const activeSessionId = route.page === "session" ? route.sessionId : null
  const activeConnectorId = (route.page === "device" || route.page === "device-workspace") ? route.connectorId : null
  const activeWorkspacePath = route.page === "device-workspace" ? route.workspacePath : null
  const settingsTab = route.page === "settings" ? route.tab : "account"

  const value: WorkspaceState = {
    connectors,
    sessions,
    isLoading,
    routeReady,
    page,
    activeSessionId,
    activeConnectorId,
    activeWorkspacePath,
    settingsTab,
    filter,
    search,
    panels,
    collapsed,
    popupBlocked,
    firstDevicePromptOpen,
    pairDeviceDialogOpen,
    openSession,
    goHome,
    navigate,
    navigateToDevice,
    navigateToWorkspace,
    setFilter,
    setSearch,
    setPanelMode,
    toggleCollapse,
    dismissPopupBlocked,
    openPairDeviceDialog,
    closePairDeviceDialog,
    closeFirstDevicePrompt,
    togglePinSession,
    toggleArchiveSession,
    markSessionRead,
    upsertSession,
    refreshData: fetchData,
  }

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
