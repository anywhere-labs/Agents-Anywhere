"use client"

import * as React from "react"
import {
  defaultFilter,
  listConnectors,
  listSessions,
  patchSession,
  type ConnectorView,
  type FilterValue,
  type SessionView,
} from "@/lib/api"

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

export type PreviewTarget = { name: string; path: string; lang: string; lines: string[] }

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

// ─── Context shape ────────────────────────────────────────────

type WorkspaceState = {
  // Data from API
  connectors: ConnectorView[]
  sessions: SessionView[]
  isLoading: boolean

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
  openPreview: (target: PreviewTarget) => void
  dismissPopupBlocked: () => void
  togglePinSession: (id: string) => void
  toggleArchiveSession: (id: string) => void
  refreshData: () => void
}

const WorkspaceContext = React.createContext<WorkspaceState | null>(null)

export function useWorkspace() {
  const ctx = React.useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}

// ─── Preview HTML builder ────────────────────────────────────

function buildPreviewHtml(target: PreviewTarget): string {
  const escaped = target.lines
    .map((line, i) => {
      const n = String(i + 1).padStart(4, " ")
      const safeL = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
      return `<div class="line"><span class="ln">${n}</span><span class="code">${safeL}</span></div>`
    })
    .join("\n")

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${target.name} - Preview</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1a1a1a; color: #d4d4d4; font-family: 'Menlo', 'Consolas', monospace; font-size: 13px; height: 100vh; display: flex; flex-direction: column; }
    header { display: flex; align-items: center; gap: 10px; padding: 0 16px; height: 44px; background: #252525; border-bottom: 1px solid #333; font-size: 13px; }
    header strong { color: #e8e8e8; }
    .scroll { flex: 1; overflow: auto; padding: 8px 0; }
    .line { display: flex; min-height: 22px; }
    .line:hover { background: rgba(255,255,255,0.04); }
    .ln { min-width: 48px; text-align: right; padding: 0 12px 0 0; color: #555; user-select: none; }
    .code { white-space: pre; padding: 0 16px 0 4px; }
  </style>
</head>
<body>
  <header>
    <strong>${target.name}</strong>
    <span style="color:#666;">—</span>
    <span style="color:#888; font-size:11px;">${target.path}</span>
  </header>
  <div class="scroll">${escaped}</div>
</body>
</html>`
}

// ─── Provider ─────────────────────────────────────────────────

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [connectors, setConnectors] = React.useState<ConnectorView[]>([])
  const [sessions, setSessions] = React.useState<SessionView[]>([])
  const [isLoading, setIsLoading] = React.useState(true)

  // Derive page state from hash — start at "home" for safe SSR, correct on mount.
  const [route, setRoute] = React.useState<ParsedRoute>({ page: "home" })

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

  // ── Fetch data from mock API ──────────────────────────────
  const fetchData = React.useCallback(async () => {
    setIsLoading(true)
    try {
      const [connRes, sessRes] = await Promise.all([
        listConnectors("mock-token"),
        listSessions("mock-token"),
      ])
      setConnectors(connRes.connectors)
      setSessions(sessRes.sessions)
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    fetchData()
  }, [fetchData])

  // ── Hash routing ──────────────────────────────────────────
  React.useEffect(() => {
    // Correct from hash immediately on mount, then keep in sync.
    setRoute(parseHash(window.location.hash))
    const handler = () => setRoute(parseHash(window.location.hash))
    window.addEventListener("hashchange", handler)
    return () => window.removeEventListener("hashchange", handler)
  }, [])

  const pushRoute = React.useCallback((r: ParsedRoute) => {
    window.location.hash = buildHash(r)
    setRoute(r)
  }, [])

  // ── Navigation helpers ────────────────────────────────────

  const openSession = React.useCallback(
    (id: string) => pushRoute({ page: "session", sessionId: id }),
    [pushRoute],
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

  // ── Preview ───────────────────────────────────────────────

  const openPreview = React.useCallback((target: PreviewTarget) => {
    const html = buildPreviewHtml(target)
    const popup = window.open("", `preview_${target.name}`, "width=900,height=680,resizable=yes,scrollbars=yes")
    if (!popup || popup.closed) {
      setPopupBlocked(true)
      return
    }
    popup.document.open()
    popup.document.write(html)
    popup.document.close()
    popup.focus()
  }, [])

  const dismissPopupBlocked = React.useCallback(() => setPopupBlocked(false), [])

  // ── Session optimistic patch helpers ──────────────────────

  const togglePinSession = React.useCallback(async (id: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s)),
    )
    const session = sessions.find((s) => s.id === id)
    if (session) {
      await patchSession("mock-token", id, { pinned: !session.pinned })
    }
  }, [sessions])

  const toggleArchiveSession = React.useCallback(async (id: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, archived: !s.archived } : s)),
    )
    const session = sessions.find((s) => s.id === id)
    if (session) {
      await patchSession("mock-token", id, { archived: !session.archived })
    }
  }, [sessions])

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
    openSession,
    goHome,
    navigate,
    navigateToDevice,
    navigateToWorkspace,
    setFilter,
    setSearch,
    setPanelMode,
    toggleCollapse,
    openPreview,
    dismissPopupBlocked,
    togglePinSession,
    toggleArchiveSession,
    refreshData: fetchData,
  }

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
