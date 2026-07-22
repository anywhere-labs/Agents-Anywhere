"use client"

import * as React from "react"
import {
  Settings,
  Trash2,
  Plus,
  RefreshCw,
  Loader2,
  KeyRound,
  ChevronRight,
  FolderOpen,
  CheckCircle2,
  Circle,
  AlertCircle,
  Archive,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { LoadingState } from "@/components/loading-state"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import type {
  DeviceRuntimeView,
  SessionView as RealSessionView,
} from "@/features/dashboard/types"
import { useWorkspace } from "@/components/workspace-context"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import { PairDeviceDialog } from "@/components/pair-device-dialog"
import type { ConnectorRevokeResponse } from "@/features/dashboard/types"
import { useIsMobile } from "@/hooks/use-mobile"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { RuntimeConfigDialog } from "@/components/runtime-config-dialog"

const DEVICE_STATUS_LABEL_KEYS = {
  online: "online",
  offline: "offline",
} as const

type ConnectorWorkspace = {
  path: string
  name: string
  sessionCount: number
  lastActiveAt: string | null
}

type DeviceSession = {
  id: string
  connectorId: string
  connectorStatus: "online" | "offline"
  runtime: string
  title?: string | null
  cwd?: string | null
  status: "idle" | "pending" | "running" | "stopping" | "blocked"
  takeover: boolean
  pinned: boolean
  archived: boolean
  unread: boolean
  lastReadSeq: number
  updatedSeq: number
  effectiveRunMode?: "chat" | "terminal" | null
  runtimeSettings?: Record<string, unknown> | null
  updatedAt?: string | null
  sortAt?: string | null
  lastActivityAt?: string | null
  lastItemAt?: string | null
}

// ── WorkspaceCard ──────────────────────────────────────────────

function WorkspaceCard({
  workspace,
  onOpen,
  onNewSession,
}: {
  workspace: ConnectorWorkspace
  onOpen: () => void
  onNewSession: () => void
}) {
  const t = useTranslations("dashboard.device")
  return (
    <div className="group grid grid-cols-[1fr_auto] items-stretch rounded-lg border border-border bg-card transition-colors hover:bg-accent/40">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 items-center gap-3 px-4 py-3 text-left"
      >
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{workspace.name}</p>
          <p className="text-xs text-muted-foreground">
            {t("sessionCount", { count: workspace.sessionCount })}
          </p>
        </div>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onNewSession}
        aria-label={t("newSession")}
        className="m-2 self-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Plus />
      </Button>
    </div>
  )
}

// ── Session row ────────────────────────────────────────────────

type SessionTabId = "active" | "archived" | "all"
const SESSION_TABS: { value: SessionTabId; labelKey: "active" | "archived" | "all" }[] = [
  { value: "active", labelKey: "active" },
  { value: "archived", labelKey: "archived" },
  { value: "all", labelKey: "all" },
]

function SessionRow({
  session,
  selected,
  selectMode,
  onClick,
  onSelectChange,
}: {
  session: DeviceSession
  selected: boolean
  selectMode: boolean
  onClick: () => void
  onSelectChange: (checked: boolean) => void
}) {
  const t = useTranslations("dashboard.device")
  return (
    <div className="flex w-full items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent/40">
      {selectMode ? (
        <Checkbox
          checked={selected}
          onCheckedChange={(checked: boolean | "indeterminate") => onSelectChange(checked === true)}
          aria-label={t("selectSession", { title: session.title ?? t("untitled") })}
        />
      ) : null}
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full border",
          session.status === "running"
            ? "border-emerald-500 bg-emerald-500"
            : session.status === "blocked"
              ? "border-amber-400/70"
              : session.status === "pending" || session.status === "stopping"
                ? "border-blue-400/70"
                : "border-muted-foreground/40",
        )}
      />
      <button
        type="button"
        onClick={selectMode ? () => onSelectChange(!selected) : onClick}
        className="min-w-0 flex-1 truncate text-left text-sm"
      >
        {session.title ?? t("untitled")}
      </button>
      <span className="shrink-0 text-xs text-muted-foreground">{formatSessionTime(session)}</span>
    </div>
  )
}

// ── DevicePage ─────────────────────────────────────────────────

const DESKTOP_WORKSPACE_PAGE_SIZE = 6
const MOBILE_WORKSPACE_PAGE_SIZE = 4

function timeValue(value: string | null | undefined) {
  return value ? new Date(value).getTime() : 0
}

function sessionActivityAt(session: DeviceSession) {
  return session.sortAt ?? session.lastActivityAt ?? session.lastItemAt ?? session.updatedAt ?? null
}

function formatSessionTime(session: DeviceSession) {
  const value = sessionActivityAt(session)
  if (!value) return ""
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value))
  } catch {
    return value
  }
}

function mergeRealSession(prev: DeviceSession | undefined, session: RealSessionView): DeviceSession {
  return {
    id: session.id,
    connectorId: session.connectorId,
    connectorStatus: session.connectorStatus,
    runtime: prev?.runtime ?? session.runtime,
    title: session.title,
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
    updatedAt: prev?.updatedAt ?? session.sortAt ?? session.lastActivityAt ?? session.lastItemAt,
    sortAt: session.sortAt,
    lastActivityAt: session.lastActivityAt,
    lastItemAt: session.lastItemAt,
  }
}

function mergeRealSessions(prev: DeviceSession[], updates: RealSessionView[]) {
  const current = new Map(prev.map((session) => [session.id, session]))
  const updated = new Map(updates.map((session) => [session.id, mergeRealSession(current.get(session.id), session)]))
  return prev.map((session) => updated.get(session.id) ?? session)
}

function workspacesFromSessions(sessions: DeviceSession[]): ConnectorWorkspace[] {
  const byPath = new Map<string, ConnectorWorkspace>()
  for (const session of sessions) {
    const path = session.cwd || "~"
    const activeAt = sessionActivityAt(session)
    const existing = byPath.get(path)
    if (existing) {
      existing.sessionCount += 1
      if (timeValue(activeAt) > timeValue(existing.lastActiveAt)) existing.lastActiveAt = activeAt
      continue
    }
    byPath.set(path, {
      path,
      name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
      sessionCount: 1,
      lastActiveAt: activeAt,
    })
  }
  return Array.from(byPath.values()).sort((a, b) => timeValue(b.lastActiveAt) - timeValue(a.lastActiveAt))
}

function runtimeStatusDot(runtime: DeviceRuntimeView) {
  if (runtime.status === "running") return "bg-emerald-500"
  if (runtime.status === "error") return "bg-destructive"
  if (runtime.status === "starting" || runtime.status === "stopping") return "bg-blue-500"
  if (runtime.active) return "bg-amber-500"
  return "bg-muted-foreground/40"
}

function runtimeErrorMessage(error: Record<string, unknown>) {
  if (typeof error.message === "string") return error.message
  if (typeof error.code === "string") return error.code
  return JSON.stringify(error)
}

export function DevicePage() {
  const t = useTranslations("dashboard.device")
  const tCommon = useTranslations("common")
  const {
    activeConnectorId,
    connectors,
    sessions: allSessions,
    navigateToWorkspace,
    openSession,
    goHome,
    refreshData,
  } = useWorkspace()
  const { session: authSession } = useAuth()
  const isMobile = useIsMobile()

  const [connector, setConnector] = React.useState<(typeof connectors)[number] | null>(null)
  const [workspaces, setWorkspaces] = React.useState<ConnectorWorkspace[]>([])
  const [runtimes, setRuntimes] = React.useState<DeviceRuntimeView[]>([])
  const [runtimesLoading, setRuntimesLoading] = React.useState(false)
  const [discoveringRuntimes, setDiscoveringRuntimes] = React.useState(false)
  const [sessions, setSessions] = React.useState<DeviceSession[]>([])
  const [loading, setLoading] = React.useState(true)

  const [showAllWorkspaces, setShowAllWorkspaces] = React.useState(false)
  const [sessionTab, setSessionTab] = React.useState<SessionTabId>("active")
  const [configRuntime, setConfigRuntime] = React.useState<DeviceRuntimeView | null>(null)
  const [savingRuntimeId, setSavingRuntimeId] = React.useState<string | null>(null)
  const [runtimeActionId, setRuntimeActionId] = React.useState<string | null>(null)
  const [removeRuntime, setRemoveRuntime] = React.useState<DeviceRuntimeView | null>(null)
  const [revokeOpen, setRevokeOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [setupCredential, setSetupCredential] = React.useState<ConnectorRevokeResponse | null>(null)
  const [setupOpen, setSetupOpen] = React.useState(false)
  const [tokenActionBusy, setTokenActionBusy] = React.useState(false)
  const [editingName, setEditingName] = React.useState(false)
  const [nameDraft, setNameDraft] = React.useState("")
  const [selectMode, setSelectMode] = React.useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = React.useState<Set<string>>(() => new Set())
  const [bulkBusy, setBulkBusy] = React.useState(false)
  const [archiveAllOpen, setArchiveAllOpen] = React.useState(false)
  const previousConnectorIdRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (!activeConnectorId) {
      previousConnectorIdRef.current = null
      return
    }
    const connectorChanged = previousConnectorIdRef.current !== activeConnectorId
    previousConnectorIdRef.current = activeConnectorId
    if (connectorChanged) {
      setLoading(true)
      setShowAllWorkspaces(false)
      setSessionTab("active")
      setRuntimes([])
      setConfigRuntime(null)
      setRemoveRuntime(null)
      setSelectMode(false)
      setSelectedSessionIds(new Set())
    }

    const currentConnector = connectors.find((item) => item.id === activeConnectorId) ?? null
    const connectorSessions = allSessions.filter((item) => item.connectorId === activeConnectorId)
    setConnector(currentConnector)
    setNameDraft(currentConnector?.name ?? "")
    setEditingName(false)
    setSessions(connectorSessions)
    setWorkspaces(workspacesFromSessions(connectorSessions))
    setLoading(false)
  }, [activeConnectorId, connectors, allSessions])

  React.useEffect(() => {
    if (!authSession?.accessToken || !activeConnectorId) return
    let cancelled = false
    setRuntimesLoading(true)
    dashboardApi.getConnectorRuntimes(authSession.accessToken, activeConnectorId)
      .then((response) => {
        if (!cancelled) setRuntimes(response.runtimes)
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : t("loadRuntimesFailed"))
      })
      .finally(() => {
        if (!cancelled) setRuntimesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeConnectorId, authSession?.accessToken, t])

  const workspacePageSize = isMobile ? MOBILE_WORKSPACE_PAGE_SIZE : DESKTOP_WORKSPACE_PAGE_SIZE
  const visibleWorkspaces = showAllWorkspaces ? workspaces : workspaces.slice(0, workspacePageSize)
  const hiddenCount = workspaces.length - workspacePageSize

  const filteredSessions = sessions.filter((s) => {
    if (sessionTab === "active") return !s.archived
    if (sessionTab === "archived") return s.archived
    return true
  })
  const targetArchiveSelected = sessionTab !== "archived" || Array.from(selectedSessionIds).some((id) => !sessions.find((s) => s.id === id)?.archived)
  const targetArchiveAll = sessionTab !== "archived"
  const allVisibleSelected = filteredSessions.length > 0 && filteredSessions.every((session) => selectedSessionIds.has(session.id))
  const configuredRuntimes = runtimes
    .filter((runtime) => runtime.configured)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
  const discoveredRuntimes = runtimes
    .filter((runtime) => runtime.present && !runtime.configured)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))

  if (loading || !connector) {
    return (
      <LoadingState className="h-full" />
    )
  }

  const handleRevoke = async () => {
    if (!authSession?.accessToken) return
    setTokenActionBusy(true)
    try {
      const result = await dashboardApi.revokeConnector(authSession.accessToken, connector.id)
      setConnector((prev) => (prev ? { ...prev, status: "offline" } : prev))
      setRevokeOpen(false)
      if (connector.status === "offline") {
        setSetupCredential(result)
        setSetupOpen(true)
      }
      refreshData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("setupFailed"))
    } finally {
      setTokenActionBusy(false)
    }
  }

  const submitName = async () => {
    if (!authSession?.accessToken) return
    const nextName = nameDraft.trim()
    if (!nextName || nextName === connector.name) {
      setNameDraft(connector.name)
      setEditingName(false)
      return
    }

    try {
      const result = await dashboardApi.updateConnector(authSession.accessToken, connector.id, { name: nextName })
      setConnector(result.connector)
      setNameDraft(result.connector.name)
      setEditingName(false)
      refreshData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("renameFailed"))
      setNameDraft(connector.name)
      setEditingName(false)
    }
  }

  const handleDelete = async () => {
    if (!authSession?.accessToken) return
    await dashboardApi.deleteConnector(authSession.accessToken, connector.id)
    setDeleteOpen(false)
    refreshData()
    goHome()
  }

  const replaceRuntime = (runtime: DeviceRuntimeView) => {
    setRuntimes((current) => current.map((item) => item.runtimeId === runtime.runtimeId ? runtime : item))
  }

  const discoverRuntimes = async () => {
    if (!authSession?.accessToken) return
    setDiscoveringRuntimes(true)
    try {
      const response = await dashboardApi.discoverConnectorRuntimes(authSession.accessToken, connector.id)
      setRuntimes(response.runtimes)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("discoverRuntimesFailed"))
    } finally {
      setDiscoveringRuntimes(false)
    }
  }

  const saveRuntimeConfig = async (runtime: DeviceRuntimeView, config: Record<string, unknown>) => {
    if (!authSession?.accessToken) return
    setSavingRuntimeId(runtime.runtimeId)
    try {
      const response = await dashboardApi.putConnectorRuntimeConfig(
        authSession.accessToken,
        connector.id,
        runtime.runtimeId,
        config,
      )
      replaceRuntime(response)
      toast.success(t("runtimeConfigSaved", { name: runtime.displayName }))
    } catch (error) {
      const message = error instanceof Error ? error.message : t("saveRuntimeConfigFailed")
      toast.error(message)
      throw error
    } finally {
      setSavingRuntimeId(null)
    }
  }

  const toggleRuntime = async (runtime: DeviceRuntimeView, active: boolean) => {
    if (!authSession?.accessToken) return
    setRuntimeActionId(runtime.runtimeId)
    try {
      const response = await dashboardApi.setConnectorRuntimeActive(
        authSession.accessToken,
        connector.id,
        runtime.runtimeId,
        active,
      )
      replaceRuntime(response)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("runtimeActionFailed"))
    } finally {
      setRuntimeActionId(null)
    }
  }

  const deleteRuntimeConfig = async () => {
    if (!authSession?.accessToken || !removeRuntime) return
    setRuntimeActionId(removeRuntime.runtimeId)
    try {
      const response = await dashboardApi.deleteConnectorRuntimeConfig(
        authSession.accessToken,
        connector.id,
        removeRuntime.runtimeId,
      )
      replaceRuntime(response)
      setRemoveRuntime(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("deleteRuntimeConfigFailed"))
    } finally {
      setRuntimeActionId(null)
    }
  }

  const toggleSessionSelection = (id: string, checked: boolean) => {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const toggleAllVisible = (checked: boolean) => {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev)
      for (const session of filteredSessions) {
        if (checked) next.add(session.id)
        else next.delete(session.id)
      }
      return next
    })
  }

  const closeSelectMode = () => {
    setSelectMode(false)
    setSelectedSessionIds(new Set())
  }

  const bulkArchiveSelected = async () => {
    if (!authSession?.accessToken || selectedSessionIds.size === 0) return
    setBulkBusy(true)
    try {
      const response = await dashboardApi.bulkArchiveSessions(authSession.accessToken, Array.from(selectedSessionIds), targetArchiveSelected)
      setSessions((prev) => mergeRealSessions(prev, response.sessions))
      closeSelectMode()
      refreshData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("bulkArchiveFailed"))
    } finally {
      setBulkBusy(false)
    }
  }

  const archiveAll = async () => {
    if (!authSession?.accessToken) return
    setBulkBusy(true)
    try {
      const response = await dashboardApi.archiveConnectorSessions(authSession.accessToken, connector.id, {
        archived: targetArchiveAll,
        scope: sessionTab,
      })
      setSessions((prev) => mergeRealSessions(prev, response.sessions))
      setArchiveAllOpen(false)
      closeSelectMode()
      refreshData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("bulkArchiveFailed"))
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <ScrollArea className="h-full min-h-0 w-full">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">

        {/* Header */}
        <div className="flex items-center gap-3">
          <DashboardSidebarToggle className="-ml-2" />
          {editingName ? (
            <Input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.currentTarget.value)}
              onBlur={() => void submitName()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitName()
                if (event.key === "Escape") {
                  setNameDraft(connector.name)
                  setEditingName(false)
                }
              }}
              className="h-9 max-w-xs rounded-lg px-2 text-2xl font-semibold tracking-tight"
              aria-label={t("deviceName")}
              autoFocus
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setNameDraft(connector.name)
                setEditingName(true)
              }}
              className="truncate text-left text-2xl font-semibold tracking-tight underline-offset-4 hover:underline"
              title={t("clickToRename")}
            >
              {connector.name}
            </button>
          )}
          <div className="flex items-center gap-1.5 text-sm">
            {connector.status === "online" ? (
              <CheckCircle2 className="size-4 text-emerald-500" />
            ) : (
              <Circle className="size-4 text-muted-foreground/40" />
            )}
            <span
              className={cn(
                "font-medium",
                "max-sm:sr-only",
                connector.status === "online" ? "text-emerald-500" : "text-muted-foreground",
              )}
            >
              {t(DEVICE_STATUS_LABEL_KEYS[connector.status])}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="max-sm:size-8 max-sm:px-0"
              onClick={() => {
                if (connector.status === "offline") {
                  void handleRevoke()
                } else {
                  setRevokeOpen(true)
                }
              }}
              disabled={tokenActionBusy}
              aria-label={tokenActionBusy ? t("preparing") : connector.status === "offline" ? t("setup") : t("revoke")}
            >
              <KeyRound />
              <span className="max-sm:sr-only">
                {tokenActionBusy ? t("preparing") : connector.status === "offline" ? t("setup") : t("revoke")}
              </span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              aria-label={t("deleteDevice")}
            >
              <Trash2 />
            </Button>
          </div>
        </div>

        <Separator className="my-6" />

        {/* Runtime lifecycle */}
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {t("agentRuntimes")}
            </h2>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void discoverRuntimes()}
              disabled={connector.status !== "online"}
            >
              <RefreshCw className={cn(discoveringRuntimes && "animate-spin")} />
              {discoveringRuntimes ? t("discoveringRuntimes") : t("refreshRuntimes")}
            </Button>
          </div>

          {runtimesLoading ? <LoadingState className="min-h-24" /> : (
            <TooltipProvider>
              <div className="flex flex-col gap-5">
                <div>
                  <h3 className="mb-2 text-sm font-medium">{t("configuredRuntimes")}</h3>
                  {configuredRuntimes.length === 0 ? (
                    <p className="px-2 py-3 text-sm text-muted-foreground">{t("noConfiguredRuntimes")}</p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {configuredRuntimes.map((runtime) => (
                        <div key={runtime.runtimeId} className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/30">
                          {runtimeActionId === runtime.runtimeId ? (
                            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                          ) : (
                            <span className={cn("size-2 shrink-0 rounded-full", runtimeStatusDot(runtime))} />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium">{runtime.displayName}</span>
                              <Badge variant="outline" className="shrink-0 font-normal">
                                {t(`runtimeStatus.${runtime.status}`)}
                              </Badge>
                              {runtime.error ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge variant="destructive" className="shrink-0 gap-1">
                                      <AlertCircle className="size-3" />
                                      {t("runtimeIssue")}
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-sm">
                                    {runtimeErrorMessage(runtime.error)}
                                  </TooltipContent>
                                </Tooltip>
                              ) : null}
                            </div>
                            {!runtime.present ? (
                              <p className="mt-0.5 text-xs text-muted-foreground">{t("runtimeNotReported")}</p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => setConfigRuntime(runtime)}
                              aria-label={t("configureRuntime", { name: runtime.displayName })}
                            >
                              <Settings />
                            </Button>
                            <Switch
                              checked={runtime.active}
                              onCheckedChange={(active: boolean) => void toggleRuntime(runtime, active)}
                              disabled={runtimeActionId === runtime.runtimeId || (!runtime.active && (connector.status !== "online" || !runtime.present))}
                              aria-label={runtime.active ? t("deactivateRuntime", { name: runtime.displayName }) : t("activateRuntime", { name: runtime.displayName })}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => setRemoveRuntime(runtime)}
                              disabled={runtimeActionId === runtime.runtimeId}
                              aria-label={t("deleteRuntimeConfig", { name: runtime.displayName })}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <Separator />

                <div>
                  <h3 className="mb-2 text-sm font-medium">{t("discoveredRuntimes")}</h3>
                  {discoveredRuntimes.length === 0 ? (
                    <p className="px-2 py-3 text-sm text-muted-foreground">{t("noDiscoveredRuntimes")}</p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {discoveredRuntimes.map((runtime) => {
                        const available = runtime.discovery.available !== false
                        return (
                          <div key={runtime.runtimeId} className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/30">
                            <span className={cn("size-2 shrink-0 rounded-full", available ? "bg-muted-foreground/50" : "bg-amber-500")} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{runtime.displayName}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {available ? t("runtimeDiscovered") : t("runtimeExecutableNotFound")}
                              </p>
                            </div>
                            <Button type="button" variant="outline" size="sm" onClick={() => setConfigRuntime(runtime)}>
                              {t("configure")}
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </TooltipProvider>
          )}
        </section>

        {/* Workspaces */}
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {t("workspaces")}
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => navigateToWorkspace(connector.id, "~")}
              aria-label={t("newSession")}
            >
              <Plus />
            </Button>
          </div>

          {workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noWorkspaces")}</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {visibleWorkspaces.map((ws) => (
                  <WorkspaceCard
                    key={ws.path}
                    workspace={ws}
                    onOpen={() => navigateToWorkspace(connector.id, ws.path)}
                    onNewSession={() => navigateToWorkspace(connector.id, ws.path)}
                  />
                ))}
              </div>

              {(() => {
                const nextWorkspace = workspaces[workspacePageSize]
                if (showAllWorkspaces || hiddenCount <= 0 || !nextWorkspace) return null
                return (
                  <button
                    type="button"
                    onClick={() => navigateToWorkspace(connector.id, nextWorkspace.path)}
                    className="mt-3 flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="mx-0.5 text-foreground">{t("showAllMore", { count: hiddenCount })}</span>
                    <ChevronRight className="size-3.5" />
                  </button>
                )
              })()}
            </>
          )}
        </section>

        {/* Sessions */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {t("sessions")}
            </h2>
            <div className="flex items-center gap-2">
              {selectMode ? (
                <Button type="button" variant="ghost" size="sm" onClick={closeSelectMode} disabled={bulkBusy}>
                  {tCommon("cancel")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectMode(true)
                  }}
                  disabled={filteredSessions.length === 0}
                >
                  {t("select")}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setArchiveAllOpen(true)}
                disabled={filteredSessions.length === 0 || bulkBusy}
              >
                <Archive />
                {targetArchiveAll ? t("archiveAll") : t("unarchiveAll")}
              </Button>
            </div>
          </div>

          <ToggleGroup
            type="single"
            value={sessionTab}
            onValueChange={(value: string) => {
              if (value) setSessionTab(value as SessionTabId)
            }}
            size="sm"
            className="mb-3"
          >
            {SESSION_TABS.map((tab) => (
              <ToggleGroupItem
                key={tab.value}
                value={tab.value}
              >
                {t(tab.labelKey)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {selectMode ? (
            <div className="mb-3 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
              <Checkbox
                checked={allVisibleSelected}
                onCheckedChange={(checked: boolean | "indeterminate") => toggleAllVisible(checked === true)}
                aria-label={t("selectAllVisible")}
              />
              <span className="flex-1 text-muted-foreground">
                {t("selectedCount", { count: selectedSessionIds.size })}
              </span>
              <Button
                size="sm"
                onClick={() => void bulkArchiveSelected()}
                disabled={selectedSessionIds.size === 0 || bulkBusy}
              >
                {bulkBusy ? t("working") : targetArchiveSelected ? t("archiveSelected") : t("unarchiveSelected")}
              </Button>
            </div>
          ) : null}

          {filteredSessions.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("noSessions")}</p>
          ) : (
            <div className="flex flex-col">
              {filteredSessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  selected={selectedSessionIds.has(s.id)}
                  selectMode={selectMode}
                  onClick={() => openSession(s.id)}
                  onSelectChange={(checked) => toggleSessionSelection(s.id, checked)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {configRuntime ? (
        <RuntimeConfigDialog
          runtimeName={configRuntime.displayName}
          schema={configRuntime.schema}
          uiSchema={configRuntime.uiSchema}
          config={configRuntime.config}
          saving={savingRuntimeId === configRuntime.runtimeId}
          open
          onOpenChange={(open) => { if (!open) setConfigRuntime(null) }}
          onSave={(config) => saveRuntimeConfig(configRuntime, config)}
        />
      ) : null}

      <PairDeviceDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        setupCredential={setupCredential}
        title={t("setUpDevice")}
        onConnectorCreated={() => {
          refreshData()
        }}
      />

      {/* Revoke confirm */}
      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("revokeDescription", { name: connector.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevoke} disabled={tokenActionBusy}>
              {tokenActionBusy ? t("revoking") : t("revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription", { name: connector.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removeRuntime !== null} onOpenChange={(open: boolean) => {
        if (!open) setRemoveRuntime(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteRuntimeConfigTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteRuntimeConfigDescription", { name: removeRuntime?.displayName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void deleteRuntimeConfig()}
              disabled={Boolean(removeRuntime && runtimeActionId === removeRuntime.runtimeId)}
            >
              {t("deleteRuntimeConfigAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={archiveAllOpen} onOpenChange={setArchiveAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{targetArchiveAll ? t("archiveAllTitle") : t("unarchiveAllTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {targetArchiveAll
                ? t("archiveAllDescription", { name: connector.name })
                : t("unarchiveAllDescription", { name: connector.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void archiveAll()} disabled={bulkBusy}>
              {bulkBusy ? t("working") : targetArchiveAll ? t("archiveAll") : t("unarchiveAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  )
}
