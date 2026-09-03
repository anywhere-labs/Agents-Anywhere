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
import type {
  ConnectorView as RealConnectorView,
  DashboardSnapshotMessage,
  ProjectCreateRequest,
  ProjectPatchRequest,
  ProjectView,
  SessionLocalTimelineState,
  SessionPageInfo,
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
import { hasDesktopConnectorBridge } from "@/features/desktop/bridge"

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
 *   device/:id/workspace/:path   →  #/device/conn-3/workspace/~path~
 */
export type AppPage = "home" | "session" | "settings" | "dashboard" | "team" | "service" | "mobile-connections" | "device" | "device-workspace"

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
  | { page: "device-workspace"; connectorId: string; workspacePath: string }

type WorkspaceHistoryMeta = {
  index: number
  maxIndex: number
}

const WORKSPACE_HISTORY_STATE_KEY = "__agents_anywhere_workspace_history"

/** Encode a file path for use in a URL hash segment */
function encodePath(p: string) { return encodeURIComponent(p) }
function decodePath(p: string) { return decodeURIComponent(p) }

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
    case "home":      return route.projectId ? `#/new-session/${encodeURIComponent(route.projectId)}` : "#/"
    case "session":   return `#/session/${route.sessionId}`
    case "settings":  return `#/settings/${route.tab}`
    case "dashboard": return "#/dashboard"
    case "team":      return "#/team"
    case "service":   return "#/service"
    case "mobile-connections": return "#/mobile-connections"
    case "device":    return `#/device/${route.connectorId}`
    case "device-workspace":
      return `#/device/${route.connectorId}/workspace/${encodePath(route.workspacePath)}`
  }
}

function readWorkspaceHistoryMeta(state: unknown): WorkspaceHistoryMeta | null {
  if (!state || typeof state !== "object") return null
  const value = (state as Record<string, unknown>)[WORKSPACE_HISTORY_STATE_KEY]
  if (!value || typeof value !== "object") return null
  const meta = value as Partial<WorkspaceHistoryMeta>
  const index = meta.index
  const maxIndex = meta.maxIndex
  if (typeof index !== "number" || typeof maxIndex !== "number") return null
  if (!Number.isInteger(index) || !Number.isInteger(maxIndex)) return null
  if (index < 0 || maxIndex < index) return null
  return { index, maxIndex }
}

function historyStateWithMeta(state: unknown, meta: WorkspaceHistoryMeta): Record<string, unknown> {
  const base = state && typeof state === "object" && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {}
  return { ...base, [WORKSPACE_HISTORY_STATE_KEY]: meta }
}

function replaceCurrentHistoryMeta(meta: WorkspaceHistoryMeta) {
  window.history.replaceState(
    historyStateWithMeta(window.history.state, meta),
    "",
    window.location.href,
  )
}

function isWorkspaceRouteHash(hash: string): boolean {
  const path = hash.replace(/^#\/?/, "").split("?")[0] ?? ""
  return (
    path === "" ||
    path === "/" ||
    path === "app" ||
    path.startsWith("session/") ||
    path.startsWith("new-session/") ||
    path === "settings" ||
    path.startsWith("settings/") ||
    path === "dashboard" ||
    path === "team" ||
    path === "service" ||
    path === "mobile-connections" ||
    path === "device" ||
    path.startsWith("device/")
  )
}

function mapConnector(connector: RealConnectorView): ConnectorView {
  return {
    id: connector.id,
    userId: connector.userId,
    name: connector.name,
    deviceOs: connector.deviceOs,
    connectorKind: connector.connectorKind,
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

function sessionSortMillis(session: SessionView): number {
  const raw = session.sortAt
  if (!raw) return 0
  const value = Date.parse(raw)
  return Number.isFinite(value) ? value : 0
}

function sortSessionViews(sessions: SessionView[]): SessionView[] {
  return [...sessions].sort((a, b) =>
    sessionSortMillis(b) - sessionSortMillis(a) || b.id.localeCompare(a.id),
  )
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

function mergeProjectSessions(
  current: Record<string, SessionView[]>,
  incoming: SessionView[],
): Record<string, SessionView[]> {
  if (Object.keys(current).length === 0 || incoming.length === 0) return current
  const incomingById = new Map(incoming.map((session) => [session.id, session]))
  let changed = false
  const next: Record<string, SessionView[]> = {}

  for (const [projectId, sessions] of Object.entries(current)) {
    const merged = sessions
      .map((session) => incomingById.get(session.id) ?? session)
      .filter((session) => session.projectId === projectId && !session.archived)
    const knownIds = new Set(merged.map((session) => session.id))
    for (const session of incoming) {
      if (session.projectId === projectId && !session.archived && !knownIds.has(session.id)) {
        merged.push(session)
      }
    }
    const sorted = sortSessionViews(merged)
    next[projectId] = sorted
    if (!sameStableValue(sessions, sorted)) changed = true
  }

  return changed ? next : current
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
  if (
    message.type !== "dashboard.snapshot" ||
    !Array.isArray(message.connectors) ||
    !Array.isArray(message.sessions) ||
    !isSessionPageInfo(message.sessionPages?.active) ||
    !isSessionPageInfo(message.sessionPages?.archived)
  ) return null

  return {
    ...(message as DashboardSnapshotMessage),
    projects: Array.isArray(message.projects) ? message.projects : [],
  }
}

function isSessionPageInfo(value: unknown): value is SessionPageInfo {
  if (!value || typeof value !== "object") return false
  const page = value as Partial<SessionPageInfo>
  return (
    typeof page.hasMore === "boolean" &&
    (typeof page.nextCursor === "string" || page.nextCursor === null)
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

export type WorkspaceState = {
  // Data from API
  connectors: ConnectorView[]
  sessions: SessionView[]
  projects: ProjectView[]
  projectSessionsById: Record<string, SessionView[]>
  loadingProjectSessionIds: string[]
  isLoading: boolean
  hasMoreSessions: boolean
  isLoadingMoreSessions: boolean
  routeReady: boolean

  // Navigation
  canGoBack: boolean
  canGoForward: boolean
  page: AppPage
  activeSessionId: string | null
  activeSession: SessionView | null
  activeSessionFallback: RealSessionView | null
  activeSessionPending: boolean
  activeConnectorId: string | null
  activeWorkspacePath: string | null
  newSessionProjectId: string | null
  newSessionProject: ProjectView | null
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
  goBack: () => void
  goForward: () => void
  goHome: () => void
  replaceHome: () => void
  navigate: (page: AppPage, sub?: string) => void
  navigateToDevice: (connectorId: string) => void
  navigateToWorkspace: (connectorId: string, workspacePath: string) => void
  startProjectSession: (projectId: string) => void
  setFilter: (f: FilterValue) => void
  setSearch: (q: string) => void
  setPanelMode: (id: PanelId, mode: PanelMode) => void
  toggleCollapse: (id: PanelId) => void
  dismissPopupBlocked: () => void
  openPairDeviceDialog: () => void
  closePairDeviceDialog: () => void
  closeFirstDevicePrompt: () => void
  togglePinSession: (id: string) => void
  toggleArchiveSession: (id: string, archived?: boolean) => Promise<SessionView | null>
  renameSession: (id: string, title: string) => Promise<boolean>
  loadProjectSessions: (projectId: string) => Promise<boolean>
  createProject: (payload: ProjectCreateRequest) => Promise<ProjectView | null>
  updateProject: (projectId: string, patch: ProjectPatchRequest) => Promise<ProjectView | null>
  removeProject: (projectId: string) => Promise<boolean>
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
  loadMoreSessions: () => void
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
  const [projects, setProjects] = React.useState<ProjectView[]>([])
  const [projectSessionsById, setProjectSessionsById] = React.useState<Record<string, SessionView[]>>({})
  const [loadingProjectSessionIds, setLoadingProjectSessionIds] = React.useState<string[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [sessionPages, setSessionPages] = React.useState<DashboardSnapshotMessage["sessionPages"]>({
    active: { hasMore: false, nextCursor: null },
    archived: { hasMore: false, nextCursor: null },
  })
  const [loadingSessionPages, setLoadingSessionPages] = React.useState({
    active: false,
    archived: false,
  })
  const firstPageSessionIdsRef = React.useRef({
    active: new Set<string>(),
    archived: new Set<string>(),
  })
  const loadingSessionPagesRef = React.useRef({ active: false, archived: false })
  const loadedBeyondFirstPageRef = React.useRef({ active: false, archived: false })
  const sessionStreamSeqRef = React.useRef(new Map<string, number>())
  const pendingSessionIndicatorRef = React.useRef(new Map<string, SessionView>())
  const loadingProjectSessionIdsRef = React.useRef(new Set<string>())
  const sortSessions = React.useCallback(sortSessionViews, [])

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
  const [canGoBack, setCanGoBack] = React.useState(false)
  const [canGoForward, setCanGoForward] = React.useState(false)

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
  const historyIndexRef = React.useRef(0)
  const historyMaxIndexRef = React.useRef(0)

  optimisticMessagesRef.current = optimisticMessages
  sessionAliasesRef.current = sessionAliases

  // ── Fetch data from mock API ──────────────────────────────
  const initialLoadDoneRef = React.useRef(false)
  const lastDashboardSnapshotKeyRef = React.useRef<string | null>(null)

  const applyDashboardSnapshot = React.useCallback((message: DashboardSnapshotMessage) => {
    const snapshotKey = stableJson({
      connectors: message.connectors,
      projects: message.projects,
      sessions: message.sessions,
      sessionPages: message.sessionPages,
    })
    if (lastDashboardSnapshotKeyRef.current === snapshotKey) return
    lastDashboardSnapshotKeyRef.current = snapshotKey

    const nextConnectors = message.connectors.map(mapConnector)
    const nextProjects = sortProjectViews(message.projects)
    const nextSessions = message.sessions.map(mapSession)
    const previousFirstPageIds = new Set([
      ...firstPageSessionIdsRef.current.active,
      ...firstPageSessionIdsRef.current.archived,
    ])
    firstPageSessionIdsRef.current = {
      active: new Set(nextSessions.filter((session) => !session.archived).map((session) => session.id)),
      archived: new Set(nextSessions.filter((session) => session.archived).map((session) => session.id)),
    }
    setConnectors((current) => sameStableValue(current, nextConnectors) ? current : nextConnectors)
    setProjects((current) => sameStableValue(current, nextProjects) ? current : nextProjects)
    setProjectSessionsById((current) => mergeProjectSessions(current, nextSessions))
    setSessions((current) => {
      const currentById = new Map(current.map((session) => [session.id, session]))
      const merged = new Map(
        current
          .filter((session) => !previousFirstPageIds.has(session.id))
          .map((session) => [session.id, session]),
      )
      nextSessions.forEach((session) => {
        merged.set(
          session.id,
          reconcileSessionIndicator(currentById.get(session.id), session),
        )
      })
      const sorted = sortSessions(Array.from(merged.values()))
      return sameStableValue(current, sorted) ? current : sorted
    })
    setSessionPages((current) => {
      const next = {
        active: loadedBeyondFirstPageRef.current.active ? current.active : message.sessionPages.active,
        archived: loadedBeyondFirstPageRef.current.archived ? current.archived : message.sessionPages.archived,
      }
      return sameStableValue(current, next) ? current : next
    })
    setIsLoading(false)
    initialLoadDoneRef.current = true
  }, [reconcileSessionIndicator, sortSessions])

  const fetchData = React.useCallback(async () => {
    if (!initialLoadDoneRef.current) {
      setIsLoading(true)
    }
    try {
      if (authSession?.accessToken) {
        const [connRes, projectRes, activeRes, archivedRes] = await Promise.all([
          dashboardApi.listConnectors(authSession.accessToken),
          dashboardApi.listProjects(authSession.accessToken).catch(() => ({
            projects: [],
            serverTime: new Date().toISOString(),
          })),
          dashboardApi.listSessions(authSession.accessToken, { archived: false, limit: 100 }),
          dashboardApi.listSessions(authSession.accessToken, { archived: true, limit: 100 }),
        ])
        const nextConnectors = connRes.connectors.map(mapConnector)
        const nextProjects = sortProjectViews(projectRes.projects)
        const nextSessions = sortSessions(
          [...activeRes.sessions, ...archivedRes.sessions].map(mapSession),
        )
        firstPageSessionIdsRef.current = {
          active: new Set(activeRes.sessions.map((session) => session.id)),
          archived: new Set(archivedRes.sessions.map((session) => session.id)),
        }
        loadedBeyondFirstPageRef.current = { active: false, archived: false }
        setConnectors((current) => sameStableValue(current, nextConnectors) ? current : nextConnectors)
        setProjects((current) => sameStableValue(current, nextProjects) ? current : nextProjects)
        setProjectSessionsById((current) => mergeProjectSessions(current, nextSessions))
        setSessions((current) => sameStableValue(current, nextSessions) ? current : nextSessions)
        setSessionPages({
          active: { hasMore: activeRes.hasMore, nextCursor: activeRes.nextCursor },
          archived: { hasMore: archivedRes.hasMore, nextCursor: archivedRes.nextCursor },
        })
        return
      }
      const [connRes, sessRes] = await Promise.all([
        listMockConnectors("mock-token"),
        listMockSessions("mock-token"),
      ])
      const nextSessions = sortSessions(sessRes.sessions)
      setConnectors((current) => sameStableValue(current, connRes.connectors) ? current : connRes.connectors)
      setProjects([])
      setProjectSessionsById({})
      setSessions((current) => sameStableValue(current, nextSessions) ? current : nextSessions)
      setSessionPages({
        active: { hasMore: false, nextCursor: null },
        archived: { hasMore: false, nextCursor: null },
      })
    } finally {
      setIsLoading(false)
      initialLoadDoneRef.current = true
    }
  }, [authSession?.accessToken, sortSessions])

  const loadMoreSessions = React.useCallback(async () => {
    const token = authSession?.accessToken
    const pageKind = "active" as const
    const page = sessionPages[pageKind]
    if (!token || !page.hasMore || !page.nextCursor || loadingSessionPagesRef.current[pageKind]) return
    loadingSessionPagesRef.current[pageKind] = true
    setLoadingSessionPages((current) => ({ ...current, [pageKind]: true }))
    try {
      const response = await dashboardApi.listSessions(token, {
        archived: false,
        limit: 100,
        cursor: page.nextCursor,
      })
      const incoming = response.sessions.map(mapSession)
      setSessions((current) => {
        const merged = new Map(current.map((session) => [session.id, session]))
        incoming.forEach((session) => merged.set(session.id, session))
        return sortSessions(Array.from(merged.values()))
      })
      loadedBeyondFirstPageRef.current[pageKind] = true
      setSessionPages((current) => ({
        ...current,
        [pageKind]: { hasMore: response.hasMore, nextCursor: response.nextCursor },
      }))
    } catch {
      // Keep the current cursor so reaching the sentinel can retry later.
    } finally {
      loadingSessionPagesRef.current[pageKind] = false
      setLoadingSessionPages((current) => ({ ...current, [pageKind]: false }))
    }
  }, [authSession?.accessToken, sessionPages, sortSessions])

  React.useEffect(() => {
    initialLoadDoneRef.current = false
    lastDashboardSnapshotKeyRef.current = null
    firstPageSessionIdsRef.current = { active: new Set(), archived: new Set() }
    loadingSessionPagesRef.current = { active: false, archived: false }
    loadedBeyondFirstPageRef.current = { active: false, archived: false }
    sessionStreamSeqRef.current = new Map()
    pendingSessionIndicatorRef.current = new Map()
    loadingProjectSessionIdsRef.current = new Set()
    setLoadingProjectSessionIds([])
    setProjectSessionsById({})
    setProjects([])
    setSessionPages({
      active: { hasMore: false, nextCursor: null },
      archived: { hasMore: false, nextCursor: null },
    })
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

  const syncHistoryAvailability = React.useCallback(() => {
    const index = historyIndexRef.current
    const maxIndex = historyMaxIndexRef.current
    setCanGoBack(index > 0)
    setCanGoForward(index < maxIndex)
  }, [])

  // ── Hash routing ──────────────────────────────────────────
  React.useEffect(() => {
    const initialHash = window.location.hash || "#/"
    const existingMeta = readWorkspaceHistoryMeta(window.history.state)
    const initialIndex = existingMeta?.index ?? 0
    const initialMaxIndex = Math.max(existingMeta?.maxIndex ?? initialIndex, initialIndex)
    historyIndexRef.current = initialIndex
    historyMaxIndexRef.current = initialMaxIndex
    replaceCurrentHistoryMeta({ index: initialIndex, maxIndex: initialMaxIndex })
    syncHistoryAvailability()

    // Correct from hash immediately on mount, then keep in sync.
    const initialRoute = parseHash(initialHash)
    routeRef.current = initialRoute
    setRoute(initialRoute)
    setRouteReady(true)
    const handler = () => {
      const nextHash = window.location.hash || "#/"
      if (!isWorkspaceRouteHash(nextHash)) return

      const nextRoute = parseHash(nextHash)
      const existing = readWorkspaceHistoryMeta(window.history.state)
      if (existing) {
        const nextIndex = existing.index
        const nextMaxIndex = Math.max(
          historyMaxIndexRef.current,
          existing.maxIndex,
          nextIndex,
        )
        historyIndexRef.current = nextIndex
        historyMaxIndexRef.current = nextMaxIndex
        if (nextMaxIndex !== existing.maxIndex) {
          replaceCurrentHistoryMeta({ index: nextIndex, maxIndex: nextMaxIndex })
        }
      } else {
        // A direct hash change outside the workspace starts a fresh app history.
        historyIndexRef.current = 0
        historyMaxIndexRef.current = 0
        replaceCurrentHistoryMeta({ index: 0, maxIndex: 0 })
      }
      syncHistoryAvailability()
      routeRef.current = nextRoute
      React.startTransition(() => setRoute(nextRoute))
    }
    window.addEventListener("hashchange", handler)
    window.addEventListener("popstate", handler)
    return () => {
      window.removeEventListener("hashchange", handler)
      window.removeEventListener("popstate", handler)
    }
  }, [syncHistoryAvailability])

  const pushRoute = React.useCallback((r: ParsedRoute) => {
    const nextHash = buildHash(r)
    const currentHash = window.location.hash || "#/"
    if (nextHash === currentHash) {
      routeRef.current = r
      React.startTransition(() => setRoute(r))
      return
    }

    const nextIndex = historyIndexRef.current + 1
    historyIndexRef.current = nextIndex
    historyMaxIndexRef.current = nextIndex
    window.location.hash = nextHash
    replaceCurrentHistoryMeta({ index: nextIndex, maxIndex: nextIndex })
    syncHistoryAvailability()
    routeRef.current = r
    React.startTransition(() => setRoute(r))
  }, [syncHistoryAvailability])

  const replaceRoute = React.useCallback((r: ParsedRoute) => {
    const nextHash = buildHash(r)
    const currentMeta = readWorkspaceHistoryMeta(window.history.state)
    const meta = currentMeta ?? {
      index: historyIndexRef.current,
      maxIndex: historyMaxIndexRef.current,
    }
    routeRef.current = r
    window.history.replaceState(
      historyStateWithMeta(window.history.state, meta),
      "",
      nextHash,
    )
    React.startTransition(() => setRoute(r))
  }, [])

  const goBack = React.useCallback(() => {
    if (historyIndexRef.current <= 0) return
    window.history.back()
  }, [])

  const goForward = React.useCallback(() => {
    if (historyIndexRef.current >= historyMaxIndexRef.current) return
    window.history.forward()
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
        fetchData()
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

  const navigateToWorkspace = React.useCallback(
    (connectorId: string, workspacePath: string) =>
      pushRoute({ page: "device-workspace", connectorId, workspacePath }),
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
    if (hasDesktopConnectorBridge()) {
      firstDeviceWizardCheckedRef.current = true
      return
    }
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

  // ── Project mutation helpers ─────────────────────────────

  const upsertProject = React.useCallback((project: ProjectView) => {
    setProjects((current) => {
      const index = current.findIndex((item) => item.id === project.id)
      if (index === -1) return sortProjectViews([project, ...current])
      const next = [...current]
      next[index] = project
      return sortProjectViews(next)
    })
  }, [])

  const loadProjectSessions = React.useCallback(async (projectId: string): Promise<boolean> => {
    const token = authSession?.accessToken
    if (!token || loadingProjectSessionIdsRef.current.has(projectId)) return false

    loadingProjectSessionIdsRef.current.add(projectId)
    setLoadingProjectSessionIds((current) => current.includes(projectId) ? current : [...current, projectId])
    try {
      const loaded = new Map<string, SessionView>()
      let cursor: string | null = null
      do {
        const response = await dashboardApi.listProjectSessions(token, projectId, {
          archived: false,
          limit: 100,
          cursor,
        })
        response.sessions.map(mapSession).forEach((session) => loaded.set(session.id, session))
        cursor = response.hasMore ? response.nextCursor : null
      } while (cursor)

      const nextSessions = sortSessions(Array.from(loaded.values()))
      setProjectSessionsById((current) => ({ ...current, [projectId]: nextSessions }))
      setSessions((current) => {
        const merged = new Map(current.map((session) => [session.id, session]))
        nextSessions.forEach((session) => merged.set(session.id, session))
        return sortSessions(Array.from(merged.values()))
      })
      return true
    } catch {
      return false
    } finally {
      loadingProjectSessionIdsRef.current.delete(projectId)
      setLoadingProjectSessionIds((current) => current.filter((id) => id !== projectId))
    }
  }, [authSession?.accessToken, sortSessions])

  const createProject = React.useCallback(async (
    payload: ProjectCreateRequest,
  ): Promise<ProjectView | null> => {
    const token = authSession?.accessToken
    if (!token) return null
    try {
      const response = await dashboardApi.createProject(token, payload)
      upsertProject(response.project)
      return response.project
    } catch {
      return null
    }
  }, [authSession?.accessToken, upsertProject])

  const updateProject = React.useCallback(async (
    projectId: string,
    patch: ProjectPatchRequest,
  ): Promise<ProjectView | null> => {
    const token = authSession?.accessToken
    if (!token) return null
    try {
      const response = await dashboardApi.updateProject(token, projectId, patch)
      upsertProject(response.project)
      return response.project
    } catch {
      return null
    }
  }, [authSession?.accessToken, upsertProject])

  const removeProject = React.useCallback(async (projectId: string): Promise<boolean> => {
    const token = authSession?.accessToken
    if (!token) return false
    try {
      await dashboardApi.deleteProject(token, projectId)
      setProjects((current) => current.filter((project) => project.id !== projectId))
      setProjectSessionsById((current) => {
        if (!(projectId in current)) return current
        const next = { ...current }
        delete next[projectId]
        return next
      })
      setSessions((current) => current.map((session) =>
        session.projectId === projectId ? { ...session, projectId: null } : session,
      ))
      if (routeRef.current.page === "home" && routeRef.current.projectId === projectId) {
        pushRoute({ page: "home" })
      }
      return true
    } catch {
      return false
    }
  }, [authSession?.accessToken, pushRoute])

  const archiveProjectSessions = React.useCallback(async (projectId: string): Promise<boolean> => {
    const token = authSession?.accessToken
    if (!token) return false
    try {
      const response = await dashboardApi.archiveProjectSessions(token, projectId, {
        archived: true,
        scope: "active",
      })
      const archivedSessions = response.sessions.map(mapSession)
      setSessions((current) => {
        const merged = new Map(current.map((session) => [session.id, session]))
        archivedSessions.forEach((session) => merged.set(session.id, session))
        return sortSessions(Array.from(merged.values()))
      })
      setProjectSessionsById((current) => ({ ...current, [projectId]: [] }))
      setProjects((current) => sortProjectViews(current.map((project) =>
        project.id === projectId ? { ...project, activeSessionCount: 0 } : project,
      )))
      return true
    } catch {
      return false
    }
  }, [authSession?.accessToken, sortSessions])

  const upsertSession = React.useCallback((session: RealSessionView) => {
    const mapped = mapSession(session)
    setSessions((prev) => {
      const index = prev.findIndex((item) => item.id === mapped.id)
      if (index === -1) return sortSessions([mapped, ...prev])
      const next = [...prev]
      next[index] = reconcileSessionIndicator(prev[index], mapped)
      return sortSessions(next)
    })
    setProjectSessionsById((current) => mergeProjectSessions(current, [mapped]))
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
      upsertSession(response.session)
      return mapSession(response.session)
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
      if (index === -1) return sortSessions([mapped, ...withoutLocal])
      const next = [...withoutLocal]
      next[index] = mapped
      return sortSessions(next)
    })
    setProjectSessionsById((current) => mergeProjectSessions(current, [mapped]))
    const currentRoute = routeRef.current
    if (currentRoute.page === "session" && currentRoute.sessionId === localSessionId) {
      replaceRoute({ page: "session", sessionId: session.id })
    }
  }, [replaceRoute, sortSessions])

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

  const validPages: AppPage[] = ["home", "session", "settings", "dashboard", "team", "service", "mobile-connections", "device", "device-workspace"]
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
  const newSessionProjectId = route.page === "home" ? route.projectId ?? null : null
  const newSessionProject = newSessionProjectId
    ? projects.find((project) => project.id === newSessionProjectId) ?? null
    : null
  const settingsTab = route.page === "settings" ? route.tab : "account"

  const value: WorkspaceState = {
    connectors,
    sessions,
    projects,
    projectSessionsById,
    loadingProjectSessionIds,
    isLoading,
    hasMoreSessions: sessionPages.active.hasMore,
    isLoadingMoreSessions: loadingSessionPages.active,
    routeReady,
    page,
    activeSessionId,
    activeSession,
    activeSessionFallback: activeSessionOptimisticState?.session ?? null,
    activeSessionPending,
    activeConnectorId,
    activeWorkspacePath,
    newSessionProjectId,
    newSessionProject,
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
    canGoBack,
    canGoForward,
    openSession,
    goBack,
    goForward,
    goHome,
    replaceHome,
    navigate,
    navigateToDevice,
    navigateToWorkspace,
    startProjectSession,
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
    loadProjectSessions,
    createProject,
    updateProject,
    removeProject,
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
    loadMoreSessions,
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
