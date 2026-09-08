"use client"

import * as React from "react"
import {
  defaultFilter,
  listConnectors as listMockConnectors,
  listSessions as listMockSessions,
  patchSession as patchMockSession,
  type ConnectorView,
  type FilterValue,
  type SessionView as DemoSessionView,
} from "@/lib/demo-api"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import { resolveWorkspaceProject } from "@/features/dashboard/project-workspaces"
import type {
  ConnectorView as RealConnectorView,
  DashboardSnapshotMessage,
  ProjectCreateRequest,
  ProjectPatchRequest,
  ProjectView,
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
  timelineClientMessageId,
  withServerAttachments,
} from "@/components/session/optimistic-timeline"
import { sortSessionViews } from "@/components/session/session-list-order"
import { isApiError } from "@/lib/api/errors"

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
 *   mobile-connections           →  #/mobile-connections
 *   home + project prefill       →  #/new-session/proj-1
 *   device/:id                   →  #/device/conn-3
 */
export type AppPage = "home" | "session" | "settings" | "dashboard" | "team" | "service" | "mobile-connections" | "device"

export type WorkspaceSessionView = DemoSessionView & {
  projectId?: string | null
}

type SessionView = WorkspaceSessionView

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
  | { page: "home"; projectId?: string }
  | { page: "session"; sessionId: string }
  | { page: "settings"; tab: string }
  | { page: "dashboard" }
  | { page: "team" }
  | { page: "service" }
  | { page: "mobile-connections" }
  | { page: "device"; connectorId: string }

function parseHash(hash: string): ParsedRoute {
  const path = hash.replace(/^#\/?/, "")
  if (!path || path === "/") return { page: "home" }

  const parts = path.split("/")
  switch (parts[0]) {
    case "new-session":
      return parts[1]
        ? { page: "home", projectId: decodeURIComponent(parts[1]) }
        : { page: "home" }
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
    case "mobile-connections":
      return { page: "mobile-connections" }
    case "device": {
      const connectorId = parts[1]
      if (!connectorId) return { page: "home" }
      return { page: "device", connectorId }
    }
    default:
      return { page: "home" }
  }
}

function buildHash(route: ParsedRoute): string {
  switch (route.page) {
    case "home":      return route.projectId ? `#/new-session/${encodeURIComponent(route.projectId)}` : "#/"
    case "session":   return `#/session/${route.sessionId}`
    case "settings":  return `#/settings/${route.tab}`
    case "dashboard": return "#/dashboard"
    case "team":      return "#/team"
    case "service":   return "#/service"
    case "mobile-connections": return "#/mobile-connections"
    case "device":    return `#/device/${route.connectorId}`
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
    projectId: session.projectId ?? null,
    connectorStatus: session.connectorStatus,
    runtime: session.runtime,
    runtimeId: session.runtimeId,
    runtimeType: session.runtimeType,
    runtimeName: session.runtimeName,
    runtimeTypeDisplayName: session.runtimeTypeDisplayName,
    externalSessionId: session.externalSessionId,
    title: session.title || "Untitled session",
    cwd: session.cwd,
    status: session.status,
    takeover: session.takeover,
    pinned: session.pinned,
    pinnedAt: session.pinnedAt,
    archived: session.archived,
    archivedAt: session.archivedAt,
    userArchived: session.userArchived,
    sourceAvailability: session.sourceAvailability,
    sourceAvailabilityReason: session.sourceAvailabilityReason,
    sourceAvailabilityUpdatedAt: session.sourceAvailabilityUpdatedAt,
    sourceObservationOrigin: session.sourceObservationOrigin,
    archiveSource: session.archiveSource,
    unread: session.unread,
    lastReadSeq: session.lastReadSeq,
    latestTurnEndSeq: session.latestTurnEndSeq,
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

function projectSortMillis(project: ProjectView): number {
  const raw = project.pinnedAt || project.lastActivityAt || project.updatedAt
  const value = Date.parse(raw)
  return Number.isFinite(value) ? value : 0
}

function sortProjectViews(projects: ProjectView[]): ProjectView[] {
  return [...projects].sort((a, b) =>
    Number(b.pinned) - Number(a.pinned) ||
    projectSortMillis(b) - projectSortMillis(a) ||
    a.name.localeCompare(b.name) ||
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

function parseDashboardSnapshotMessage(value: unknown): DashboardSnapshotMessage | null {
  if (!value || typeof value !== "object") return null
  const message = value as Partial<DashboardSnapshotMessage>
  if (!(
    message.type === "dashboard.snapshot" &&
    Array.isArray(message.connectors) &&
    Array.isArray(message.projects) &&
    Array.isArray(message.sessions)
  )) return null

  return message as DashboardSnapshotMessage
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

export type WorkspaceState = {
  // Data from API
  connectors: ConnectorView[]
  sessions: SessionView[]
  projects: ProjectView[]
  isLoading: boolean
  routeReady: boolean

  // Navigation
  page: AppPage
  activeSessionId: string | null
  activeSession: SessionView | null
  activeSessionFallback: RealSessionView | null
  activeSessionPending: boolean
  activeConnectorId: string | null
  newSessionProjectId: string | null
  newSessionProject: ProjectView | null
  settingsTab: string

  // Sidebar filter/search
  filter: FilterValue
  search: string
  sidebarShowsSessions: boolean

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
  replaceHome: () => void
  navigate: (page: AppPage, sub?: string) => void
  navigateToDevice: (connectorId: string) => void
  startProjectSession: (projectId: string) => void
  setFilter: (f: FilterValue) => void
  setSearch: (q: string) => void
  setSidebarShowsSessions: (show: boolean) => void
  setPanelMode: (id: PanelId, mode: PanelMode) => void
  toggleCollapse: (id: PanelId) => void
  dismissPopupBlocked: () => void
  openPairDeviceDialog: () => void
  closePairDeviceDialog: () => void
  closeFirstDevicePrompt: () => void
  togglePinSession: (id: string) => void
  toggleArchiveSession: (id: string, archived?: boolean) => Promise<SessionView | null>
  renameSession: (id: string, title: string) => Promise<boolean>
  createProject: (payload: ProjectCreateRequest) => Promise<ProjectView | null>
  resolveProject: (payload: Pick<ProjectCreateRequest, "connectorId" | "workspacePath">) => Promise<ProjectView>
  updateProject: (projectId: string, patch: ProjectPatchRequest) => Promise<ProjectView | null>
  deleteProject: (projectId: string) => Promise<boolean>
  archiveProjectSessions: (projectId: string) => Promise<boolean>
  markSessionRead: (id: string) => void
  upsertSession: (session: RealSessionView) => void
  reportSessionStreamProgress: (sessionId: string, nextSeq: number | null) => void
  addOptimisticMessage: (message: OptimisticSessionMessage) => void
  bindOptimisticSession: (localSessionId: string, session: RealSessionView, attachments?: AttachmentRef[]) => void
  clearResolvedOptimisticMessages: (sessionId: string, items: TimelineItem[]) => void
  getOptimisticItems: (sessionId: string) => TimelineItem[]
  getOptimisticSessionState: (sessionId: string) => SessionLocalTimelineState | null
  isOptimisticSession: (sessionId: string) => boolean
  markOptimisticMessageFailed: (clientMessageId: string, message: string) => void
  appendPathToComposer: (path: string) => boolean
  consumeComposerInsertion: (id: number) => void
  refreshData: () => void
}

const WorkspaceContext = React.createContext<WorkspaceState | null>(null)

const FIRST_DEVICE_WIZARD_DISMISSED_KEY = "aa-first-device-wizard-dismissed-v1"
const PANEL_MODE_STORAGE_KEY = "aa-session-runtime-panel-modes-v1"
const SIDEBAR_SHOW_SESSIONS_STORAGE_KEY = "aa-sidebar-show-sessions-v1"
const SESSION_SEND_OPTIMISTIC_TOP_MS = 1_000
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

function readStoredSidebarShowsSessions(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(SIDEBAR_SHOW_SESSIONS_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

function writeStoredSidebarShowsSessions(show: boolean) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(SIDEBAR_SHOW_SESSIONS_STORAGE_KEY, show ? "1" : "0")
  } catch {
    // Persisting the sidebar preference is best-effort.
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
  const currentAccessTokenRef = React.useRef(authSession?.accessToken ?? null)
  currentAccessTokenRef.current = authSession?.accessToken ?? null
  const [connectors, setConnectors] = React.useState<ConnectorView[]>([])
  const [sessions, setSessions] = React.useState<SessionView[]>([])
  const [projects, setProjects] = React.useState<ProjectView[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const sessionStreamSeqRef = React.useRef(new Map<string, number>())
  const pendingSessionIndicatorRef = React.useRef(new Map<string, SessionView>())
  // Local sends temporarily affect presentation order only; remote status stays authoritative.
  const optimisticTopUntilRef = React.useRef(new Map<string, number>())
  const optimisticTopTimersRef = React.useRef(new Map<string, number>())
  const sortSessions = React.useCallback(
    (values: readonly SessionView[]) => sortSessionViews(values, {
      now: Date.now(),
      optimisticTopUntil: optimisticTopUntilRef.current,
    }),
    [],
  )

  const clearOptimisticTopTimer = React.useCallback((sessionId: string) => {
    const timer = optimisticTopTimersRef.current.get(sessionId)
    if (timer !== undefined) window.clearTimeout(timer)
    optimisticTopTimersRef.current.delete(sessionId)
  }, [])

  const setOptimisticTopUntil = React.useCallback(
    (sessionId: string, until: number) => {
      clearOptimisticTopTimer(sessionId)
      if (until <= Date.now()) {
        optimisticTopUntilRef.current.delete(sessionId)
        return
      }
      optimisticTopUntilRef.current.set(sessionId, until)
      const timer = window.setTimeout(() => {
        if (optimisticTopUntilRef.current.get(sessionId) !== until) return
        optimisticTopUntilRef.current.delete(sessionId)
        optimisticTopTimersRef.current.delete(sessionId)
        setSessions((current) => sortSessions(current))
      }, until - Date.now())
      optimisticTopTimersRef.current.set(sessionId, timer)
    },
    [clearOptimisticTopTimer, sortSessions],
  )

  const clearOptimisticTop = React.useCallback((sessionId: string) => {
    clearOptimisticTopTimer(sessionId)
    optimisticTopUntilRef.current.delete(sessionId)
  }, [clearOptimisticTopTimer])

  const transferOptimisticTop = React.useCallback(
    (fromSessionId: string, toSessionId: string, minimumUntil = 0) => {
      const until = optimisticTopUntilRef.current.get(fromSessionId)
      clearOptimisticTop(fromSessionId)
      setOptimisticTopUntil(
        toSessionId,
        Math.max(
          until ?? 0,
          minimumUntil,
          optimisticTopUntilRef.current.get(toSessionId) ?? 0,
        ),
      )
    },
    [clearOptimisticTop, setOptimisticTopUntil],
  )

  React.useEffect(() => () => {
    for (const timer of optimisticTopTimersRef.current.values()) {
      window.clearTimeout(timer)
    }
    optimisticTopTimersRef.current.clear()
    optimisticTopUntilRef.current.clear()
  }, [authSession?.accessToken])

  const reconcileSessionIndicator = React.useCallback((
    current: SessionView | undefined,
    incoming: SessionView,
  ): SessionView => {
    const appliedSeq = sessionStreamSeqRef.current.get(incoming.id)
    const shouldWaitForTimeline = Boolean(
      current &&
      sessionStatusIsBusy(current.status) &&
      incoming.status === "idle" &&
      appliedSeq !== undefined &&
      appliedSeq < incoming.updatedSeq,
    )
    if (shouldWaitForTimeline && current) {
      pendingSessionIndicatorRef.current.set(incoming.id, incoming)
      return {
        ...incoming,
        status: current.status,
        unread: current.unread,
      }
    }
    pendingSessionIndicatorRef.current.delete(incoming.id)
    return incoming
  }, [])

  // Derive page state from hash — start at "home" for safe SSR, correct on mount.
  const [route, setRoute] = React.useState<ParsedRoute>({ page: "home" })
  const [routeReady, setRouteReady] = React.useState(false)

  const [filter, setFilter] = React.useState<FilterValue>(defaultFilter)
  const [search, setSearch] = React.useState("")
  const [sidebarShowsSessions, setSidebarShowsSessionsState] = React.useState(
    readStoredSidebarShowsSessions,
  )
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

  // ── Shared workspace inventory ────────────────────────────
  const initialLoadDoneRef = React.useRef(false)
  const lastDashboardSnapshotKeyRef = React.useRef<string | null>(null)
  const dashboardDataGenerationRef = React.useRef(0)
  const projectDataGenerationRef = React.useRef(0)
  const checkedMissingProjectsRef = React.useRef(new Set<string>())
  const projectRefreshInFlightRef = React.useRef<{ token: string; generation: number; promise: Promise<void> } | null>(null)

  const refreshProjects = React.useCallback((): Promise<void> => {
    const token = authSession?.accessToken
    if (!token) return Promise.resolve()
    const pending = projectRefreshInFlightRef.current
    const generation = projectDataGenerationRef.current
    if (pending?.token === token && pending.generation === generation) return pending.promise
    const promise = dashboardApi.listProjects(token).then((response) => {
      if (currentAccessTokenRef.current !== token || projectDataGenerationRef.current !== generation) return
      dashboardDataGenerationRef.current += 1
      const next = sortProjectViews(response.projects)
      setProjects((current) => sameStableValue(current, next) ? current : next)
    })
    const request = { token, generation, promise }
    projectRefreshInFlightRef.current = request
    const clear = () => { if (projectRefreshInFlightRef.current === request) projectRefreshInFlightRef.current = null }
    void promise.then(clear, clear)
    return promise
  }, [authSession?.accessToken])

  React.useEffect(() => {
    if (!authSession?.accessToken || isLoading) return
    const projectIds = new Set(projects.map((project) => project.id))
    const missing = new Set(sessions
      .filter((session) => !session.id.startsWith("local:") && (!session.projectId || !projectIds.has(session.projectId)))
      .map((session) => session.projectId ? `project:${session.projectId}` : `session:${session.id}`))
    checkedMissingProjectsRef.current.forEach((key) => {
      if (!missing.has(key)) checkedMissingProjectsRef.current.delete(key)
    })
    const unchecked = [...missing].filter((key) => !checkedMissingProjectsRef.current.has(key))
    if (unchecked.length === 0) return
    unchecked.forEach((key) => checkedMissingProjectsRef.current.add(key))
    void refreshProjects().catch(() => {
      // Retry on a later data update, without repeatedly fetching an orphan's project list.
      unchecked.forEach((key) => checkedMissingProjectsRef.current.delete(key))
    })
  }, [authSession?.accessToken, isLoading, projects, refreshProjects, sessions])

  const applyDashboardSnapshot = React.useCallback((message: DashboardSnapshotMessage) => {
    const snapshotKey = stableJson({
      connectors: message.connectors,
      projects: message.projects,
      sessions: message.sessions,
    })
    if (lastDashboardSnapshotKeyRef.current === snapshotKey) return
    lastDashboardSnapshotKeyRef.current = snapshotKey
    dashboardDataGenerationRef.current += 1
    projectDataGenerationRef.current += 1

    const nextConnectors = message.connectors.map(mapConnector)
    const nextProjects = sortProjectViews(message.projects)
    setConnectors((current) => sameStableValue(current, nextConnectors) ? current : nextConnectors)
    setProjects((current) => sameStableValue(current, nextProjects) ? current : nextProjects)
    setSessions((current) => {
      const currentById = new Map(current.map((session) => [session.id, session]))
      const next = sortSessions(message.sessions.map((session) => {
        const mapped = mapSession(session)
        const previous = currentById.get(mapped.id)
        if (previous && previous.updatedSeq > mapped.updatedSeq) return previous
        return reconcileSessionIndicator(currentById.get(mapped.id), mapped)
      }))
      const present = new Set(next.map((session) => session.id))
      const pending = new Set(optimisticMessagesRef.current.flatMap((message) => [message.sessionId, message.localSessionId]))
      const merged = sortSessions([...next, ...current.filter((session) => !present.has(session.id) && pending.has(session.id))])
      return sameStableValue(current, merged) ? current : merged
    })
    setIsLoading(false)
    initialLoadDoneRef.current = true
  }, [reconcileSessionIndicator, sortSessions])

  const fetchDataInFlightRef = React.useRef<{ token: string | null; promise: Promise<boolean> } | null>(null)
  const fetchData = React.useCallback((): Promise<boolean> => {
    const token = authSession?.accessToken ?? null
    const pending = fetchDataInFlightRef.current
    if (pending?.token === token) return pending.promise

    const requestGeneration = ++dashboardDataGenerationRef.current
    if (!initialLoadDoneRef.current) setIsLoading(true)
    const promise = (async () => {
      try {
        if (token) {
          const [connRes, projectRes, sessionRes] = await Promise.all([
            dashboardApi.listConnectors(token),
            dashboardApi.listProjects(token),
            dashboardApi.listSessionInventory(token),
          ])
          if (
            dashboardDataGenerationRef.current !== requestGeneration ||
            currentAccessTokenRef.current !== token
          ) return false
          applyDashboardSnapshot({
            type: "dashboard.snapshot",
            connectors: connRes.connectors,
            projects: projectRes.projects,
            sessions: sessionRes.sessions,
            sessionPages: { active: { hasMore: false, nextCursor: null }, archived: { hasMore: false, nextCursor: null } },
            serverTime: sessionRes.serverTime,
          })
        } else {
          const [connRes, sessRes] = await Promise.all([listMockConnectors("mock-token"), listMockSessions("mock-token")])
          if (dashboardDataGenerationRef.current !== requestGeneration || currentAccessTokenRef.current !== token) return false
          setConnectors(connRes.connectors)
          setProjects([])
          setSessions(sortSessions(sessRes.sessions))
          initialLoadDoneRef.current = true
          setIsLoading(false)
        }
        return true
      } catch {
        return false
      } finally {
        if (currentAccessTokenRef.current === token) setIsLoading(false)
      }
    })()
    const request = { token, promise }
    fetchDataInFlightRef.current = request
    void promise.finally(() => { if (fetchDataInFlightRef.current === request) fetchDataInFlightRef.current = null })
    return promise
  }, [applyDashboardSnapshot, authSession?.accessToken, sortSessions])

  const setSidebarShowsSessions = React.useCallback((show: boolean) => {
    setSidebarShowsSessionsState(show)
    writeStoredSidebarShowsSessions(show)
  }, [])

  React.useEffect(() => {
    initialLoadDoneRef.current = false
    lastDashboardSnapshotKeyRef.current = null
    dashboardDataGenerationRef.current += 1
    projectDataGenerationRef.current += 1
    checkedMissingProjectsRef.current = new Set()
    sessionStreamSeqRef.current = new Map()
    pendingSessionIndicatorRef.current = new Map()
    setProjects([])
    setSessions([])
    setIsLoading(true)
  }, [authSession?.accessToken])

  React.useEffect(() => {
    if (authSession?.accessToken) return
    void fetchData().catch(() => undefined)
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
        if (!cancelled && !initialLoadDoneRef.current) {
          void fetchData().then((loaded) => {
            if (!loaded && !cancelled && !initialLoadDoneRef.current) {
              scheduleInitialFallback()
            }
          })
        }
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
            const snapshot = parseDashboardSnapshotMessage(message)
            if (!snapshot) return
            if (fallbackTimer !== null) {
              window.clearTimeout(fallbackTimer)
              fallbackTimer = null
            }
            scheduleDashboardSnapshot(snapshot)
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

    scheduleInitialFallback()
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
          if (index === -1) return sortSessions([mapped, ...prev])
          const next = [...prev]
          next[index] = mapped
          return sortSessions(next)
        })
      })
      .catch(() => {
        void fetchData().catch(() => undefined)
      })
      .finally(() => {
        readRequestsRef.current.delete(id)
      })
  }, [authSession?.accessToken, fetchData, sortSessions])

  const openSession = React.useCallback(
    (id: string) => {
      markSessionRead(id)
      pushRoute({ page: "session", sessionId: id })
    },
    [markSessionRead, pushRoute],
  )

  const goHome = React.useCallback(() => pushRoute({ page: "home" }), [pushRoute])
  const replaceHome = React.useCallback(() => replaceRoute({ page: "home" }), [replaceRoute])

  const navigate = React.useCallback(
    (page: AppPage, sub?: string) => {
      if (page === "home") pushRoute({ page: "home" })
      else if (page === "session") pushRoute({ page: "session", sessionId: sub ?? "" })
      else if (page === "settings") pushRoute({ page: "settings", tab: sub ?? "account" })
      else if (page === "dashboard") pushRoute({ page: "dashboard" })
      else if (page === "team") pushRoute({ page: "team" })
      else if (page === "service") pushRoute({ page: "service" })
      else if (page === "mobile-connections") pushRoute({ page: "mobile-connections" })
    },
    [pushRoute],
  )

  const navigateToDevice = React.useCallback(
    (connectorId: string) => pushRoute({ page: "device", connectorId }),
    [pushRoute],
  )

  const startProjectSession = React.useCallback(
    (projectId: string) => pushRoute({ page: "home", projectId }),
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

  // ── Project mutation helpers ────────────────────────────

  const upsertProject = React.useCallback((project: ProjectView) => {
    dashboardDataGenerationRef.current += 1
    projectDataGenerationRef.current += 1
    setProjects((current) => {
      const index = current.findIndex((item) => item.id === project.id)
      if (index === -1) return sortProjectViews([project, ...current])
      const next = [...current]
      next[index] = project
      return sortProjectViews(next)
    })
  }, [])

  const createProject = React.useCallback(async (
    payload: ProjectCreateRequest,
  ): Promise<ProjectView | null> => {
    const token = authSession?.accessToken
    if (!token) return null
    const response = await dashboardApi.createProject(token, payload)
    if (currentAccessTokenRef.current !== token) return null
    upsertProject(response.project)
    void refreshProjects().catch(() => undefined)
    return response.project
  }, [authSession?.accessToken, refreshProjects, upsertProject])

  const updateProject = React.useCallback(async (
    projectId: string,
    patch: ProjectPatchRequest,
  ): Promise<ProjectView | null> => {
    const token = authSession?.accessToken
    if (!token) return null
    try {
      const response = await dashboardApi.updateProject(token, projectId, patch)
      if (currentAccessTokenRef.current !== token) return null
      upsertProject(response.project)
      void refreshProjects().catch(() => undefined)
      return response.project
    } catch (error) {
      if (isApiError(error) && error.code === "project_name_conflict") throw error
      return null
    }
  }, [authSession?.accessToken, refreshProjects, upsertProject])

  const resolveProject = React.useCallback(async (payload: Pick<ProjectCreateRequest, "connectorId" | "workspacePath">): Promise<ProjectView> => {
    const token = authSession?.accessToken
    if (!token) throw new Error("Authentication required")
    let path = payload.workspacePath.trim()
    if (path.startsWith("~")) {
      const response = await dashboardApi.connectorFsList(token, payload.connectorId, { root: path, path: "." })
      if (!response.result.path || response.result.targetType === "file") throw new Error("Could not resolve workspace directory")
      path = response.result.path
    }
    const project = await resolveWorkspaceProject({
      projects,
      connectorId: payload.connectorId,
      path,
      deviceOs: connectors.find((connector) => connector.id === payload.connectorId)?.deviceOs,
      list: async () => (await dashboardApi.listProjects(token)).projects,
      create: async (body) => (await dashboardApi.createProject(token, body)).project,
    })
    upsertProject(project)
    return project
  }, [authSession?.accessToken, connectors, projects, upsertProject])

  const deleteProject = React.useCallback(async (projectId: string): Promise<boolean> => {
    const token = authSession?.accessToken
    if (!token) return false
    try {
      await dashboardApi.deleteProject(token, projectId)
      if (currentAccessTokenRef.current !== token) return false
      dashboardDataGenerationRef.current += 1
      projectDataGenerationRef.current += 1
      setProjects((current) => current.filter((project) => project.id !== projectId))
      setSessions((current) => sortSessions(current.map((session) =>
        session.projectId === projectId ? { ...session, projectId: null } : session,
      )))
      void refreshProjects().catch(() => undefined)
      return true
    } catch {
      return false
    }
  }, [authSession?.accessToken, refreshProjects, sortSessions])

  const archiveProjectSessions = React.useCallback(async (projectId: string): Promise<boolean> => {
    const token = authSession?.accessToken
    if (!token) return false
    try {
      const response = await dashboardApi.archiveProjectSessions(token, projectId, {
        archived: true,
        scope: "all",
      })
      if (currentAccessTokenRef.current !== token) return false
      dashboardDataGenerationRef.current += 1
      projectDataGenerationRef.current += 1
      const archivedSessions = response.sessions.map(mapSession)
      setSessions((current) => {
        const merged = new Map(current.map((session) => [session.id, session]))
        archivedSessions.forEach((session) => merged.set(session.id, session))
        return sortSessions(Array.from(merged.values()))
      })
      setProjects((current) => sortProjectViews(current.map((project) =>
        project.id === projectId ? {
          ...project,
          manuallyCreated: false,
          activeSessionCount: 0,
          sidebarSessionCounts: { active: 0, archived: archivedSessions.length },
        } : project,
      )))
      void refreshProjects().catch(() => undefined)
      return true
    } catch {
      return false
    }
  }, [authSession?.accessToken, refreshProjects, sortSessions])

  const upsertSession = React.useCallback((session: RealSessionView) => {
    dashboardDataGenerationRef.current += 1
    const mapped = mapSession(session)
    setSessions((prev) => {
      const index = prev.findIndex((item) => item.id === mapped.id)
      if (index === -1) return sortSessions([mapped, ...prev])
      const next = [...prev]
      next[index] = reconcileSessionIndicator(prev[index], mapped)
      return sortSessions(next)
    })
  }, [reconcileSessionIndicator, sortSessions])

  const reportSessionStreamProgress = React.useCallback((
    sessionId: string,
    nextSeq: number | null,
  ) => {
    if (nextSeq === null) {
      sessionStreamSeqRef.current.delete(sessionId)
      const pending = pendingSessionIndicatorRef.current.get(sessionId)
      if (!pending) return
      pendingSessionIndicatorRef.current.delete(sessionId)
      setSessions((current) => sortSessions(
        current.map((session) => session.id === sessionId ? pending : session),
      ))
      return
    }

    const currentSeq = sessionStreamSeqRef.current.get(sessionId) ?? 0
    const appliedSeq = Math.max(currentSeq, nextSeq)
    sessionStreamSeqRef.current.set(sessionId, appliedSeq)
    const pending = pendingSessionIndicatorRef.current.get(sessionId)
    if (!pending || appliedSeq < pending.updatedSeq) return
    pendingSessionIndicatorRef.current.delete(sessionId)
    setSessions((current) => sortSessions(
      current.map((session) => session.id === sessionId ? pending : session),
    ))
  }, [sortSessions])

  // ── Session mutation helpers ──────────────────────────────

  const togglePinSession = React.useCallback(async (id: string) => {
    const targetSession = sessions.find((s) => s.id === id)
    if (!targetSession) return

    if (authSession?.accessToken) {
      const response = await dashboardApi.patchSession(authSession.accessToken, id, { pinned: !targetSession.pinned })
      upsertSession(response.session)
    } else {
      const response = await patchMockSession("mock-token", id, { pinned: !targetSession.pinned })
      setSessions((prev) => sortSessions(prev.map((s) => (s.id === id ? response.session : s))))
    }
  }, [authSession?.accessToken, sessions, sortSessions, upsertSession])

  const toggleArchiveSession = React.useCallback(async (
    id: string,
    archived?: boolean,
  ): Promise<SessionView | null> => {
    const targetSession = sessionsRef.current.find((session) => session.id === id)
    if (!targetSession) return null
    const nextArchived = archived ?? !targetSession.archived

    if (authSession?.accessToken) {
      const response = await dashboardApi.patchSession(authSession.accessToken, id, { archived: nextArchived })
      const mapped = mapSession(response.session)
      upsertSession(response.session)
      return mapped
    }

    const response = await patchMockSession("mock-token", id, { archived: nextArchived })
    setSessions((prev) => sortSessions(prev.map((session) => (
      session.id === id ? response.session : session
    ))))
    return response.session
  }, [authSession?.accessToken, sortSessions, upsertSession])

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
        setSessions((prev) => sortSessions(prev.map((s) => (s.id === id ? response.session : s))))
      }
      return true
    } catch {
      return false
    }
  }, [authSession?.accessToken, sessions, sortSessions, upsertSession])

  const addOptimisticMessage = React.useCallback((message: OptimisticSessionMessage) => {
    setOptimisticTopUntil(
      message.sessionId,
      Date.now() + SESSION_SEND_OPTIMISTIC_TOP_MS,
    )
    setSessions((current) => sortSessions(current))
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
  }, [setOptimisticTopUntil, sortSessions])

  const bindOptimisticSession = React.useCallback((localSessionId: string, session: RealSessionView, attachments: AttachmentRef[] = []) => {
    // The local new-session row is not shown in the sidebar. Start the full
    // stability window when its canonical row first becomes sortable instead
    // of spending that window while create-and-start is still pending.
    transferOptimisticTop(
      localSessionId,
      session.id,
      Date.now() + SESSION_SEND_OPTIMISTIC_TOP_MS,
    )
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
      if (index === -1) return sortSessions([mapped, ...withoutLocal])
      const current = withoutLocal[index]
      if (!current) return sortSessions([mapped, ...withoutLocal])
      const next = [...withoutLocal]
      next[index] = current.updatedSeq >= mapped.updatedSeq
        ? current
        : mapped
      return sortSessions(next)
    })
    const currentRoute = routeRef.current
    if (currentRoute.page === "session" && currentRoute.sessionId === localSessionId) {
      replaceRoute({ page: "session", sessionId: session.id })
    }
  }, [replaceRoute, sortSessions, transferOptimisticTop])

  const markOptimisticMessageFailed = React.useCallback((clientMessageId: string, message: string) => {
    const failed = optimisticMessagesRef.current.find(
      (entry) => entry.clientMessageId === clientMessageId,
    )
    if (failed) {
      clearOptimisticTop(failed.sessionId)
      setSessions((current) => sortSessions(current))
    }
    setOptimisticMessages((prev) => {
      const next = prev.map((entry) =>
        entry.clientMessageId === clientMessageId
          ? { ...entry, item: markOptimisticItemFailed(entry.item, message) }
          : entry,
      )
      optimisticMessagesRef.current = next
      return next
    })
  }, [clearOptimisticTop, sortSessions])

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
          // The reconciled server item owns the preview URL after replacing this optimistic item.
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

  const consumeComposerInsertion = React.useCallback((id: number) => {
    setComposerInsertion((current) => current?.id === id ? null : current)
  }, [])

  // ── Derived route fields ──────────────────────────────────

  const validPages: AppPage[] = ["home", "session", "settings", "dashboard", "team", "service", "mobile-connections", "device"]
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
  const activeConnectorId = route.page === "device" ? route.connectorId : null
  const newSessionProjectId = route.page === "home" ? route.projectId ?? null : null
  const newSessionProject = newSessionProjectId
    ? projects.find((project) => project.id === newSessionProjectId) ?? null
    : null
  const settingsTab = route.page === "settings" ? route.tab : "account"

  const value: WorkspaceState = {
    connectors,
    sessions,
    projects,
    isLoading,
    routeReady,
    page,
    activeSessionId,
    activeSession,
    activeSessionFallback: activeSessionOptimisticState?.session ?? null,
    activeSessionPending,
    activeConnectorId,
    newSessionProjectId,
    newSessionProject,
    settingsTab,
    filter,
    search,
    sidebarShowsSessions,
    panels,
    collapsed,
    popupBlocked,
    firstDevicePromptOpen,
    pairDeviceDialogOpen,
    composerInsertion,
    optimisticMessages,
    openSession,
    goHome,
    replaceHome,
    navigate,
    navigateToDevice,
    startProjectSession,
    setFilter,
    setSearch,
    setSidebarShowsSessions,
    setPanelMode,
    toggleCollapse,
    dismissPopupBlocked,
    openPairDeviceDialog,
    closePairDeviceDialog,
    closeFirstDevicePrompt,
    togglePinSession,
    toggleArchiveSession,
    renameSession,
    createProject,
    resolveProject,
    updateProject,
    deleteProject,
    archiveProjectSessions,
    markSessionRead,
    upsertSession,
    reportSessionStreamProgress,
    addOptimisticMessage,
    bindOptimisticSession,
    clearResolvedOptimisticMessages,
    getOptimisticItems,
    getOptimisticSessionState,
    isOptimisticSession,
    markOptimisticMessageFailed,
    appendPathToComposer,
    consumeComposerInsertion,
    refreshData: fetchData,
  }

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

function sameStableValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function sessionStatusIsBusy(status: string): boolean {
  return status === "running" || status === "waiting" || status === "pending"
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
