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
  SessionStateResponse,
  SessionView as RealSessionView,
  TimelineItem,
} from "@/features/dashboard/types"
import {
  isOptimisticTimelineItem,
  markOptimisticItemFailed,
  mergeTimelineItems,
  timelineClientMessageId,
} from "@/components/session/optimistic-timeline"

// ─── Panel / page types ───────────────────────────────────────

export type PanelId = "files" | "terminal"
export type PanelMode = "docked" | "floating" | "closed"

/**
 * Page names that map to hash routes:
 *   home                         →  #/
 *   session/:id                  →  #/session/s1
 *   settings/:tab                →  #/settings/account
 *   dashboard                    →  #/dashboard
 *   team                         →  #/team
 *   service                      →  #/service
 *   device/:id                   →  #/device/conn-3
 *   device/:id/workspace/:path   →  #/device/conn-3/workspace/~path~
 */
export type AppPage = "home" | "session" | "settings" | "dashboard" | "team" | "service" | "device" | "device-workspace"

export type ComposerInsertion = {
  id: number
  sessionId: string
  text: string
}

export type OptimisticSessionMessage = {
  clientMessageId: string
  sessionId: string
  item: TimelineItem
  session?: RealSessionView
  localSessionId?: string
}

export type SessionRefreshRequest = {
  id: number
  sessionId: string
  clientMessageId?: string
}

// ─── Hash routing helpers ─────────────────────────────────────

type ParsedRoute =
  | { page: "home" }
  | { page: "session"; sessionId: string }
  | { page: "settings"; tab: string }
  | { page: "dashboard" }
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
    case "dashboard":
      return { page: "dashboard" }
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
    case "dashboard": return "#/dashboard"
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
    deviceOs: connector.deviceOs,
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
    // Keep the wire runtime id (claude / gemini / …). Display labels are applied
    // in the UI via runtimeLabel() — never store "Claude" / "Gemini CLI" here or
    // /agents/{runtime}/config-schema validation fails with string_pattern_mismatch.
    runtime: session.runtime,
    externalSessionId: session.externalSessionId,
    title: session.title || "Untitled session",
    cwd: session.cwd,
    status: session.status,
    takeover: session.takeover,
    pinned: session.pinned,
    pinnedAt: session.pinnedAt,
    archived: session.archived,
    archivedAt: session.archivedAt,
    unread: session.unread,
    lastReadSeq: session.lastReadSeq,
    lastSyncedAt: session.lastSyncedAt,
    sourceObservedAt: session.sourceObservedAt,
    lastActivityAt: session.lastActivityAt,
    lastItemAt: session.lastItemAt,
    lastItemOrderSeq: session.lastItemOrderSeq,
    sortAt: session.sortAt,
    updatedSeq: session.updatedSeq,
    effectiveRunMode: session.effectiveRunMode,
    runtimeSettings: session.runtimeSettings ?? null,
    runtimeSettingsOverride: session.runtimeSettingsOverride ?? null,
    updatedAt: relativeSessionTime(session),
  }
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
  composerInsertion: ComposerInsertion | null
  optimisticMessages: OptimisticSessionMessage[]
  sessionRefreshRequest: SessionRefreshRequest | null

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
  renameSession: (id: string, title: string) => Promise<boolean>
  markSessionRead: (id: string) => void
  upsertSession: (session: RealSessionView) => void
  addOptimisticMessage: (message: OptimisticSessionMessage) => void
  bindOptimisticSession: (localSessionId: string, session: RealSessionView) => void
  /** Remove a failed local-only optimistic session (and its sidebar row). */
  discardOptimisticSession: (localSessionId: string) => void
  clearResolvedOptimisticMessages: (sessionId: string, items: TimelineItem[]) => void
  getOptimisticItems: (sessionId: string) => TimelineItem[]
  getOptimisticSessionState: (sessionId: string) => SessionStateResponse | null
  isOptimisticSession: (sessionId: string) => boolean
  markOptimisticMessageFailed: (clientMessageId: string, message: string) => void
  requestSessionRefresh: (sessionId: string, clientMessageId?: string) => void
  appendPathToComposer: (path: string) => boolean
  refreshData: () => void
}

const WorkspaceContext = React.createContext<WorkspaceState | null>(null)

const FIRST_DEVICE_WIZARD_DISMISSED_KEY = "aa-first-device-wizard-dismissed-v1"
const PANEL_MODE_STORAGE_KEY = "aa-session-runtime-panel-modes-v1"
const DEFAULT_PANEL_MODES: Record<PanelId, PanelMode> = {
  files: "docked",
  terminal: "docked",
}
const PANEL_IDS: PanelId[] = ["files", "terminal"]

function readStoredPanelModes(): Record<PanelId, PanelMode> {
  if (typeof window === "undefined") return DEFAULT_PANEL_MODES
  try {
    const raw = window.localStorage.getItem(PANEL_MODE_STORAGE_KEY)
    if (!raw) return DEFAULT_PANEL_MODES
    const parsed = JSON.parse(raw) as Partial<Record<PanelId, PanelMode>>
    const next = { ...DEFAULT_PANEL_MODES }
    for (const id of PANEL_IDS) {
      const mode = parsed[id]
      if (mode === "docked" || mode === "floating" || mode === "closed") next[id] = persistedPanelMode(mode)
    }
    return next
  } catch {
    return DEFAULT_PANEL_MODES
  }
}

function persistedPanelMode(mode: PanelMode): PanelMode {
  return mode === "floating" ? "docked" : mode
}

function writeStoredPanelModes(panels: Record<PanelId, PanelMode>) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      PANEL_MODE_STORAGE_KEY,
      JSON.stringify({
        files: persistedPanelMode(panels.files),
        terminal: persistedPanelMode(panels.terminal),
      }),
    )
  } catch {
    // Persisting the panel preference is best-effort.
  }
}

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
  const [panels, setPanels] = React.useState<Record<PanelId, PanelMode>>(readStoredPanelModes)
  const [collapsed, setCollapsed] = React.useState<Record<PanelId, boolean>>({
    files: false,
    terminal: false,
  })
  const [popupBlocked, setPopupBlocked] = React.useState(false)
  const [firstDevicePromptOpen, setFirstDevicePromptOpen] = React.useState(false)
  const [pairDeviceDialogOpen, setPairDeviceDialogOpen] = React.useState(false)
  const [composerInsertion, setComposerInsertion] = React.useState<ComposerInsertion | null>(null)
  const [optimisticMessages, setOptimisticMessages] = React.useState<OptimisticSessionMessage[]>([])
  const [sessionRefreshRequest, setSessionRefreshRequest] = React.useState<SessionRefreshRequest | null>(null)
  const firstDeviceWizardCheckedRef = React.useRef(false)
  const composerInsertionSeqRef = React.useRef(0)
  const sessionRefreshRequestSeqRef = React.useRef(0)
  const routeRef = React.useRef<ParsedRoute>({ page: "home" })

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
    const initialRoute = parseHash(window.location.hash)
    routeRef.current = initialRoute
    setRoute(initialRoute)
    setRouteReady(true)
    const handler = () => {
      const nextRoute = parseHash(window.location.hash)
      routeRef.current = nextRoute
      React.startTransition(() => setRoute(nextRoute))
    }
    window.addEventListener("hashchange", handler)
    return () => window.removeEventListener("hashchange", handler)
  }, [])

  const pushRoute = React.useCallback((r: ParsedRoute) => {
    routeRef.current = r
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
      else if (page === "dashboard") pushRoute({ page: "dashboard" })
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
    setPanels((prev) => {
      const next = { ...prev, [id]: mode }
      writeStoredPanelModes(next)
      return next
    })
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

  const renameSession = React.useCallback(async (id: string, title: string) => {
    const nextTitle = title.trim()
    if (!nextTitle) return false

    const targetSession = sessions.find((s) => s.id === id)
    if (!targetSession) return false
    if (targetSession.title === nextTitle) return true

    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title: nextTitle } : s)),
    )

    try {
      if (authSession?.accessToken) {
        const response = await dashboardApi.patchSession(authSession.accessToken, id, { title: nextTitle })
        const mapped = mapSession(response.session)
        setSessions((prev) => prev.map((s) => (s.id === id ? mapped : s)))
      } else {
        await patchMockSession("mock-token", id, { title: nextTitle })
      }
      return true
    } catch {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title: targetSession.title } : s)),
      )
      return false
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

  const addOptimisticMessage = React.useCallback((message: OptimisticSessionMessage) => {
    setOptimisticMessages((prev) => {
      const index = prev.findIndex((item) => item.clientMessageId === message.clientMessageId)
      if (index === -1) return [...prev, message]
      const next = [...prev]
      next[index] = message
      return next
    })
    if (message.session) {
      const mapped = mapSession(message.session)
      setSessions((prev) => {
        const index = prev.findIndex((item) => item.id === mapped.id)
        if (index === -1) return [mapped, ...prev]
        const next = [...prev]
        next[index] = mapped
        return next
      })
    }
  }, [])

  const bindOptimisticSession = React.useCallback((localSessionId: string, session: RealSessionView) => {
    setOptimisticMessages((prev) =>
      prev.map((message) =>
        message.sessionId === localSessionId ||
        message.localSessionId === localSessionId ||
        message.sessionId === session.id
          ? {
              ...message,
              sessionId: session.id,
              session,
              item: { ...message.item, sessionId: session.id },
            }
          : message,
      ),
    )
    const mapped = mapSession(session)
    setSessions((prev) => {
      const withoutLocal = prev.filter((item) => item.id !== localSessionId)
      const index = withoutLocal.findIndex((item) => item.id === mapped.id)
      if (index === -1) return [mapped, ...withoutLocal]
      const next = [...withoutLocal]
      next[index] = mapped
      return next
    })
    const currentRoute = routeRef.current
    if (currentRoute.page === "session" && currentRoute.sessionId === localSessionId) {
      pushRoute({ page: "session", sessionId: session.id })
    }
  }, [pushRoute])

  const discardOptimisticSession = React.useCallback((localSessionId: string) => {
    setOptimisticMessages((prev) =>
      prev.filter(
        (message) =>
          message.localSessionId !== localSessionId && message.sessionId !== localSessionId,
      ),
    )
    setSessions((prev) => prev.filter((item) => item.id !== localSessionId))
    const currentRoute = routeRef.current
    if (currentRoute.page === "session" && currentRoute.sessionId === localSessionId) {
      pushRoute({ page: "home" })
    }
  }, [pushRoute])

  const markOptimisticMessageFailed = React.useCallback((clientMessageId: string, message: string) => {
    setOptimisticMessages((prev) =>
      prev.map((entry) =>
        entry.clientMessageId === clientMessageId
          ? { ...entry, item: markOptimisticItemFailed(entry.item, message) }
          : entry,
      ),
    )
  }, [])

  const clearResolvedOptimisticMessages = React.useCallback((sessionId: string, items: TimelineItem[]) => {
    const resolvedClientMessageIds = new Set(
      items
        .filter((item) => !isOptimisticTimelineItem(item))
        .map(timelineClientMessageId)
        .filter((id): id is string => Boolean(id)),
    )
    if (resolvedClientMessageIds.size === 0) return
    setOptimisticMessages((prev) =>
      prev.filter(
        (message) => message.sessionId !== sessionId || !resolvedClientMessageIds.has(message.clientMessageId),
      ),
    )
  }, [])

  const getOptimisticItems = React.useCallback((sessionId: string) => {
    return optimisticMessages
      .filter((message) => message.sessionId === sessionId)
      .map((message) => message.item)
  }, [optimisticMessages])

  const getOptimisticSessionState = React.useCallback((sessionId: string): SessionStateResponse | null => {
    const messages = optimisticMessages.filter((message) => message.sessionId === sessionId)
    const session = messages.find((message) => message.session)?.session
    if (!session) return null
    const items = mergeTimelineItems([], messages.map((message) => message.item))
    const nextSeq = items.reduce((max, item) => Math.max(max, item.updatedSeq), 0)
    return {
      session,
      items,
      approvals: [],
      nextSeq,
      hasMore: false,
      serverTime: new Date().toISOString(),
    }
  }, [optimisticMessages])

  const isOptimisticSession = React.useCallback((sessionId: string) => {
    return optimisticMessages.some((message) => message.localSessionId === sessionId && message.sessionId === sessionId)
  }, [optimisticMessages])

  const requestSessionRefresh = React.useCallback((sessionId: string, clientMessageId?: string) => {
    sessionRefreshRequestSeqRef.current += 1
    setSessionRefreshRequest({
      id: sessionRefreshRequestSeqRef.current,
      sessionId,
      clientMessageId,
    })
  }, [])

  const appendPathToComposer = React.useCallback((path: string) => {
    if (route.page !== "session" || !route.sessionId) return false
    const targetSession = sessions.find((session) => session.id === route.sessionId)
    if (!targetSession?.takeover) return false
    composerInsertionSeqRef.current += 1
    setComposerInsertion({
      id: composerInsertionSeqRef.current,
      sessionId: route.sessionId,
      text: `@${path}`,
    })
    return true
  }, [route, sessions])

  // ── Derived route fields ──────────────────────────────────

  const validPages: AppPage[] = ["home", "session", "settings", "dashboard", "team", "service", "device", "device-workspace"]
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
    composerInsertion,
    optimisticMessages,
    sessionRefreshRequest,
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
    renameSession,
    markSessionRead,
    upsertSession,
    addOptimisticMessage,
    bindOptimisticSession,
    discardOptimisticSession,
    clearResolvedOptimisticMessages,
    getOptimisticItems,
    getOptimisticSessionState,
    isOptimisticSession,
    markOptimisticMessageFailed,
    requestSessionRefresh,
    appendPathToComposer,
    refreshData: fetchData,
  }

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
