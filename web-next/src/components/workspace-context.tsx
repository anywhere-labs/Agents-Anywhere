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
  DashboardSnapshotMessage,
  SessionLocalTimelineState,
  SessionRuntimeState,
  SessionView as RealSessionView,
  TimelineItem,
  AttachmentRef,
} from "@/features/dashboard/types"
import {
  isOptimisticTimelineItem,
  markOptimisticItemFailed,
  mergeTimelineItems,
  revokeOptimisticItemResources,
  timelineClientMessageId,
  withServerAttachments,
} from "@/components/session/optimistic-timeline"
import { runtimeLabel } from "@/components/session/session-utils"

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
  state?: SessionRuntimeState
  localSessionId?: string
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
  }
}

function mapSession(session: RealSessionView): SessionView {
  return {
    id: session.id,
    connectorId: session.connectorId,
    connectorStatus: session.connectorStatus,
    runtime: runtimeLabel(session.runtime),
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
    updatedAt: relativeSessionTime(session),
  }
}

function sessionSortMillis(session: SessionView): number {
  const raw =
    session.sortAt ||
    session.lastActivityAt ||
    session.lastItemAt ||
    session.lastSyncedAt ||
    session.sourceObservedAt
  if (!raw) return 0
  const value = Date.parse(raw)
  return Number.isFinite(value) ? value : 0
}

function sortSessionViews(sessions: SessionView[]): SessionView[] {
  return [...sessions].sort((a, b) =>
    sessionSortMillis(b) - sessionSortMillis(a) ||
    (b.lastItemOrderSeq ?? -1) - (a.lastItemOrderSeq ?? -1) ||
    b.updatedSeq - a.updatedSeq ||
    a.id.localeCompare(b.id),
  )
}

function resolveSessionAlias(sessionId: string, aliases: Record<string, string>): string {
  let current = sessionId
  const seen = new Set<string>()
  let next = aliases[current]
  while (next && !seen.has(current)) {
    seen.add(current)
    current = next
    next = aliases[current]
  }
  return current
}

function optimisticMessageMatchesSession(
  message: OptimisticSessionMessage,
  sessionId: string,
  aliases: Record<string, string>,
): boolean {
  const canonicalId = resolveSessionAlias(sessionId, aliases)
  const messageSessionId = resolveSessionAlias(message.sessionId, aliases)
  const localSessionId = message.localSessionId ? resolveSessionAlias(message.localSessionId, aliases) : null
  return (
    message.sessionId === sessionId ||
    message.localSessionId === sessionId ||
    messageSessionId === canonicalId ||
    localSessionId === canonicalId
  )
}

function isDashboardSnapshotMessage(value: unknown): value is DashboardSnapshotMessage {
  if (!value || typeof value !== "object") return false
  const message = value as Partial<DashboardSnapshotMessage>
  return (
    message.type === "dashboard.snapshot" &&
    Array.isArray(message.connectors) &&
    Array.isArray(message.sessions)
  )
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
  activeSession: SessionView | null
  activeSessionFallback: RealSessionView | null
  activeSessionPending: boolean
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
  bindOptimisticSession: (localSessionId: string, session: RealSessionView, attachments?: AttachmentRef[]) => void
  clearResolvedOptimisticMessages: (sessionId: string, items: TimelineItem[]) => void
  getOptimisticItems: (sessionId: string) => TimelineItem[]
  getOptimisticSessionState: (sessionId: string) => SessionLocalTimelineState | null
  isOptimisticSession: (sessionId: string) => boolean
  markOptimisticMessageFailed: (clientMessageId: string, message: string) => void
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
  const [sessionAliases, setSessionAliases] = React.useState<Record<string, string>>({})
  const optimisticMessagesRef = React.useRef<OptimisticSessionMessage[]>(optimisticMessages)
  const sessionAliasesRef = React.useRef<Record<string, string>>(sessionAliases)
  const firstDeviceWizardCheckedRef = React.useRef(false)
  const composerInsertionSeqRef = React.useRef(0)
  const routeRef = React.useRef<ParsedRoute>({ page: "home" })

  optimisticMessagesRef.current = optimisticMessages
  sessionAliasesRef.current = sessionAliases

  // ── Fetch data from mock API ──────────────────────────────
  const initialLoadDoneRef = React.useRef(false)
  const lastDashboardSnapshotKeyRef = React.useRef<string | null>(null)

  const applyDashboardSnapshot = React.useCallback((message: DashboardSnapshotMessage) => {
    const snapshotKey = stableJson({
      connectors: message.connectors,
      sessions: message.sessions,
    })
    if (lastDashboardSnapshotKeyRef.current === snapshotKey) return
    lastDashboardSnapshotKeyRef.current = snapshotKey

    const nextConnectors = message.connectors.map(mapConnector)
    const nextSessions = sortSessionViews(message.sessions.map(mapSession))
    setConnectors((current) => sameStableValue(current, nextConnectors) ? current : nextConnectors)
    setSessions((current) => sameStableValue(current, nextSessions) ? current : nextSessions)
    setIsLoading(false)
    initialLoadDoneRef.current = true
  }, [])

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
        const nextConnectors = connRes.connectors.map(mapConnector)
        const nextSessions = sortSessionViews(sessRes.sessions.map(mapSession))
        setConnectors((current) => sameStableValue(current, nextConnectors) ? current : nextConnectors)
        setSessions((current) => sameStableValue(current, nextSessions) ? current : nextSessions)
        return
      }
      const [connRes, sessRes] = await Promise.all([
        listMockConnectors("mock-token"),
        listMockSessions("mock-token"),
      ])
      const nextSessions = sortSessionViews(sessRes.sessions)
      setConnectors((current) => sameStableValue(current, connRes.connectors) ? current : connRes.connectors)
      setSessions((current) => sameStableValue(current, nextSessions) ? current : nextSessions)
    } finally {
      setIsLoading(false)
      initialLoadDoneRef.current = true
    }
  }, [authSession?.accessToken])

  React.useEffect(() => {
    initialLoadDoneRef.current = false
    lastDashboardSnapshotKeyRef.current = null
    setIsLoading(true)
  }, [authSession?.accessToken])

  React.useEffect(() => {
    if (authSession?.accessToken) return
    fetchData()
  }, [authSession?.accessToken, fetchData])

  // ── Dashboard WebSocket ────────────────────────────────────
  const tokenRef = React.useRef(authSession?.accessToken ?? null)
  tokenRef.current = authSession?.accessToken ?? null
  const sessionsRef = React.useRef(sessions)
  sessionsRef.current = sessions
  const readRequestsRef = React.useRef(new Set<string>())

  React.useEffect(() => {
    if (!authSession?.accessToken) return
    let cancelled = false
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let fallbackTimer: number | null = null
    let snapshotFrame: number | null = null
    let pendingSnapshot: DashboardSnapshotMessage | null = null

    const scheduleDashboardSnapshot = (message: DashboardSnapshotMessage) => {
      pendingSnapshot = message
      if (snapshotFrame !== null) return
      snapshotFrame = window.requestAnimationFrame(() => {
        snapshotFrame = null
        const snapshot = pendingSnapshot
        pendingSnapshot = null
        if (!cancelled && snapshot) applyDashboardSnapshot(snapshot)
      })
    }

    const scheduleInitialFallback = () => {
      if (cancelled || initialLoadDoneRef.current || fallbackTimer !== null) return
      fallbackTimer = window.setTimeout(() => {
        fallbackTimer = null
        if (!cancelled && !initialLoadDoneRef.current) fetchData()
      }, 2500)
    }

    const connect = async () => {
      try {
        const ticket = await dashboardApi.createDashboardWsTicket(
          authSession.accessToken,
          "web-dashboard",
        )
        if (cancelled) return
        socket = new WebSocket(dashboardApi.dashboardWebSocketUrl(ticket.ticket))
        socket.onmessage = (event) => {
          if (cancelled || typeof event.data !== "string") return
          try {
            const message = JSON.parse(event.data) as unknown
            if (!isDashboardSnapshotMessage(message)) return
            if (fallbackTimer !== null) {
              window.clearTimeout(fallbackTimer)
              fallbackTimer = null
            }
            scheduleDashboardSnapshot(message)
          } catch { /* ignore malformed */ }
        }
        socket.onclose = () => {
          if (cancelled) return
          socket = null
          scheduleInitialFallback()
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null
            void connect()
          }, 2000)
        }
        socket.onerror = () => {
          socket?.close()
        }
      } catch {
        if (cancelled) return
        scheduleInitialFallback()
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          void connect()
        }, 2000)
      }
    }

    void connect()

    return () => {
      cancelled = true
      socket?.close()
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
      if (snapshotFrame !== null) window.cancelAnimationFrame(snapshotFrame)
      pendingSnapshot = null
    }
  }, [applyDashboardSnapshot, authSession?.accessToken, fetchData])

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

  const replaceRoute = React.useCallback((r: ParsedRoute) => {
    routeRef.current = r
    window.history.replaceState(null, "", buildHash(r))
    React.startTransition(() => setRoute(r))
  }, [])

  // ── Navigation helpers ────────────────────────────────────

  const markSessionRead = React.useCallback((id: string) => {
    const targetSession = sessionsRef.current.find((session) => session.id === id)
    if (!targetSession || !targetSession.unread || readRequestsRef.current.has(id)) return

    setSessions((prev) =>
      prev.map((session) =>
        session.id === id
          ? { ...session, unread: false, lastReadSeq: Math.max(session.lastReadSeq, session.updatedSeq) }
          : session,
      ),
    )

    if (!authSession?.accessToken) return
    readRequestsRef.current.add(id)
    dashboardApi
      .markSessionRead(authSession.accessToken, id)
      .then((response) => {
        const mapped = mapSession(response.session)
        setSessions((prev) => {
          const index = prev.findIndex((item) => item.id === mapped.id)
          if (index === -1) return sortSessionViews([mapped, ...prev])
          const next = [...prev]
          next[index] = mapped
          return sortSessionViews(next)
        })
      })
      .catch(() => {
        fetchData()
      })
      .finally(() => {
        readRequestsRef.current.delete(id)
      })
  }, [authSession?.accessToken, fetchData])

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

  const upsertSession = React.useCallback((session: RealSessionView) => {
    const mapped = mapSession(session)
    setSessions((prev) => {
      const index = prev.findIndex((item) => item.id === mapped.id)
      if (index === -1) return sortSessionViews([mapped, ...prev])
      const next = [...prev]
      next[index] = mapped
      return sortSessionViews(next)
    })
  }, [])

  // ── Session mutation helpers ──────────────────────────────

  const togglePinSession = React.useCallback(async (id: string) => {
    const targetSession = sessions.find((s) => s.id === id)
    if (!targetSession) return

    if (authSession?.accessToken) {
      const response = await dashboardApi.patchSession(authSession.accessToken, id, { pinned: !targetSession.pinned })
      upsertSession(response.session)
    } else {
      const response = await patchMockSession("mock-token", id, { pinned: !targetSession.pinned })
      setSessions((prev) => sortSessionViews(prev.map((s) => (s.id === id ? response.session : s))))
    }
  }, [authSession?.accessToken, sessions, upsertSession])

  const toggleArchiveSession = React.useCallback(async (id: string) => {
    const targetSession = sessions.find((s) => s.id === id)
    if (!targetSession) return

    if (authSession?.accessToken) {
      const response = await dashboardApi.patchSession(authSession.accessToken, id, { archived: !targetSession.archived })
      upsertSession(response.session)
    } else {
      const response = await patchMockSession("mock-token", id, { archived: !targetSession.archived })
      setSessions((prev) => sortSessionViews(prev.map((s) => (s.id === id ? response.session : s))))
    }
  }, [authSession?.accessToken, sessions, upsertSession])

  const renameSession = React.useCallback(async (id: string, title: string) => {
    const nextTitle = title.trim()
    if (!nextTitle) return false

    const targetSession = sessions.find((s) => s.id === id)
    if (!targetSession) return false
    if (targetSession.title === nextTitle) return true

    try {
      if (authSession?.accessToken) {
        const response = await dashboardApi.patchSession(authSession.accessToken, id, { title: nextTitle })
        upsertSession(response.session)
      } else {
        const response = await patchMockSession("mock-token", id, { title: nextTitle })
        setSessions((prev) => sortSessionViews(prev.map((s) => (s.id === id ? response.session : s))))
      }
      return true
    } catch {
      return false
    }
  }, [authSession?.accessToken, sessions, upsertSession])

  const addOptimisticMessage = React.useCallback((message: OptimisticSessionMessage) => {
    setOptimisticMessages((prev) => {
      const index = prev.findIndex((item) => item.clientMessageId === message.clientMessageId)
      if (index === -1) {
        const next = [...prev, message]
        optimisticMessagesRef.current = next
        return next
      }
      const next = [...prev]
      next[index] = message
      optimisticMessagesRef.current = next
      return next
    })
  }, [])

  const bindOptimisticSession = React.useCallback((localSessionId: string, session: RealSessionView, attachments: AttachmentRef[] = []) => {
    setSessionAliases((prev) => {
      if (prev[localSessionId] === session.id) return prev
      const next = { ...prev, [localSessionId]: session.id }
      sessionAliasesRef.current = next
      return next
    })
    setOptimisticMessages((prev) => {
      const next = prev.map((message) =>
        message.sessionId === localSessionId || message.sessionId === session.id
          ? {
              ...message,
              sessionId: session.id,
              session,
              state: message.state
                ? {
                    ...message.state,
                    sessionId: session.id,
                    externalSessionId: session.externalSessionId,
                  }
                : undefined,
              item: {
                ...(attachments.length > 0
                  ? withServerAttachments(message.item, attachments)
                  : message.item),
                sessionId: session.id,
              },
            }
          : message,
      )
      optimisticMessagesRef.current = next
      return next
    })
    const mapped = mapSession(session)
    setSessions((prev) => {
      const withoutLocal = prev.filter((item) => item.id !== localSessionId)
      const index = withoutLocal.findIndex((item) => item.id === mapped.id)
      if (index === -1) return sortSessionViews([mapped, ...withoutLocal])
      const next = [...withoutLocal]
      next[index] = mapped
      return sortSessionViews(next)
    })
    const currentRoute = routeRef.current
    if (currentRoute.page === "session" && currentRoute.sessionId === localSessionId) {
      replaceRoute({ page: "session", sessionId: session.id })
    }
  }, [replaceRoute])

  const markOptimisticMessageFailed = React.useCallback((clientMessageId: string, message: string) => {
    setOptimisticMessages((prev) => {
      const next = prev.map((entry) =>
        entry.clientMessageId === clientMessageId
          ? { ...entry, item: markOptimisticItemFailed(entry.item, message) }
          : entry,
      )
      optimisticMessagesRef.current = next
      return next
    })
  }, [])

  const clearResolvedOptimisticMessages = React.useCallback((sessionId: string, items: TimelineItem[]) => {
    const resolvedClientMessageIds = new Set(
      items
        .filter((item) => !isOptimisticTimelineItem(item))
        .map(timelineClientMessageId)
        .filter((id): id is string => Boolean(id)),
    )
    if (resolvedClientMessageIds.size === 0) return
    setOptimisticMessages((prev) => {
      const next: OptimisticSessionMessage[] = []
      for (const message of prev) {
        const resolved = message.sessionId === sessionId && resolvedClientMessageIds.has(message.clientMessageId)
        if (resolved) {
          revokeOptimisticItemResources(message.item)
          continue
        }
        next.push(message)
      }
      optimisticMessagesRef.current = next
      return next
    })
  }, [])

  const getOptimisticItems = React.useCallback((sessionId: string) => {
    return optimisticMessages
      .filter((message) => optimisticMessageMatchesSession(message, sessionId, sessionAliases))
      .map((message) => message.item)
  }, [optimisticMessages, sessionAliases])

  const getOptimisticSessionState = React.useCallback((sessionId: string): SessionLocalTimelineState | null => {
    const messages = optimisticMessages.filter((message) =>
      optimisticMessageMatchesSession(message, sessionId, sessionAliases),
    )
    const session = messages.find((message) => message.session)?.session
    const state = messages.find((message) => message.state)?.state
    if (!session) return null
    const items = mergeTimelineItems([], messages.map((message) => message.item))
    const nextSeq = items.reduce((max, item) => Math.max(max, item.updatedSeq), 0)
    return {
      session,
      state: state ?? null,
      items,
      nextSeq,
      hasMore: false,
      serverTime: new Date().toISOString(),
    }
  }, [optimisticMessages, sessionAliases])

  const isOptimisticSession = React.useCallback((sessionId: string) => {
    return optimisticMessages.some((message) =>
      message.localSessionId === sessionId &&
      message.sessionId === sessionId &&
      !sessionAliases[sessionId],
    )
  }, [optimisticMessages, sessionAliases])

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

  const routeSessionId = route.page === "session" ? route.sessionId : null
  const activeSessionId = routeSessionId ? resolveSessionAlias(routeSessionId, sessionAliases) : null
  const activeSessionOptimisticState = activeSessionId ? getOptimisticSessionState(activeSessionId) : null
  const activeSession = activeSessionId
    ? sessions.find((item) => item.id === activeSessionId) ??
      (activeSessionOptimisticState?.session ? mapSession(activeSessionOptimisticState.session) : null)
    : null
  const activeSessionPending = Boolean(
    routeSessionId &&
      !activeSession &&
      (routeSessionId.startsWith("session_") || sessionAliases[routeSessionId]),
  )
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
    activeSession,
    activeSessionFallback: activeSessionOptimisticState?.session ?? null,
    activeSessionPending,
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
    clearResolvedOptimisticMessages,
    getOptimisticItems,
    getOptimisticSessionState,
    isOptimisticSession,
    markOptimisticMessageFailed,
    appendPathToComposer,
    refreshData: fetchData,
  }

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

function sameStableValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
