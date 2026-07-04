"use client"

import * as React from "react"
import {
  Settings,
  Trash2,
  Plus,
  KeyRound,
  ChevronRight,
  FolderOpen,
  CheckCircle2,
  Check,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { LoadingState } from "@/components/loading-state"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import type {
  AttachedAgent,
  RuntimeReport,
  RuntimeConfigSchema,
  ConnectorRuntimeScanResponse,
  RuntimeSettingsResponse,
  SessionView as RealSessionView,
} from "@/features/dashboard/types"
import { useWorkspace } from "@/components/workspace-context"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import { PairDeviceDialog } from "@/components/pair-device-dialog"
import type { ConnectorRevokeResponse } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  effortFieldForModel,
  effectiveFieldValue,
  optionLabel,
  runtimeConfigFields,
  validEffortValue,
} from "@/features/dashboard/runtime-config"

type DeviceConnector = ReturnType<typeof useWorkspace>["connectors"][number]

const DEVICE_STATUS_LABEL_KEYS = {
  online: "online",
  offline: "offline",
} as const

type AgentRow = {
  runtime: string
  agent: AttachedAgent
  healthy: boolean
  reason: string | null
}

const ADD_AGENT_RUNTIME_OPTIONS = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
] as const

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
  status: "idle" | "running" | "waiting_approval" | "error"
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

function isConfigurableField(
  field: ReturnType<typeof effortFieldForModel>,
): field is NonNullable<ReturnType<typeof effortFieldForModel>> {
  return field !== null && field.type !== "object"
}

// ── AgentConfigDialog ──────────────────────────────────────────

function AgentConfigDialog({
  runtime,
  schema,
  settings,
  error,
  saving,
  open,
  onOpenChange,
  onSave,
}: {
  runtime: string
  schema: RuntimeConfigSchema | null
  settings: Record<string, unknown> | null
  error: string | null
  saving: boolean
  open: boolean
  onOpenChange: (v: boolean) => void
  onSave: (settings: Record<string, unknown>) => Promise<void>
}) {
  const t = useTranslations("dashboard.device")
  const tCommon = useTranslations("common")
  const [draft, setDraft] = React.useState<Record<string, unknown>>(settings ?? {})

  React.useEffect(() => {
    if (open) setDraft(settings ?? {})
  }, [open, settings])

  const fields = React.useMemo(() => runtimeConfigFields(schema, draft, "device"), [draft, schema])
  const modelField = fields.find((field) => field.key === "model")
  const visibleFields = fields
    .map((field) => field.key === "effort" ? effortFieldForModel(modelField, field, draft.model) : field)
    .filter(isConfigurableField)

  const patch = (key: string, value: unknown) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === "model") {
        const nextEffortField = effortFieldForModel(modelField, fields.find((field) => field.key === "effort"), value)
        const nextEffort = validEffortValue(nextEffortField, prev.effort)
        if (nextEffort) next.effort = nextEffort
        else delete next.effort
      }
      return next
    })
  }

  const submit = async () => {
    await onSave(draft)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{runtime}</DialogTitle>
          <DialogDescription>{t("defaultConfiguration")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {error ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>{t("agentSettingsFailed")}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {visibleFields.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noAgentSettings")}</p>
          ) : (
            visibleFields.map((field) => {
              const value = draft[field.key]
              if (field.type === "boolean") {
                return (
                  <label key={field.key} className="flex items-start gap-3 rounded-lg border border-border p-3">
                    <Checkbox
                      checked={Boolean(value)}
                      onCheckedChange={(checked) => patch(field.key, checked === true)}
                    />
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-sm font-medium">{field.label}</span>
                      {field.description ? <span className="text-xs text-muted-foreground">{field.description}</span> : null}
                    </span>
                  </label>
                )
              }
              if (field.type === "enum" && field.options?.length) {
                const selectedValue = effectiveFieldValue(field, value)
                const selectedLabel = optionLabel(field, value, field.label)
                return (
                  <div key={field.key} className="flex flex-col gap-2">
                    <Label>{field.label}</Label>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full min-w-0 justify-between"
                        >
                          <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
                          <ChevronRight className="size-3.5 shrink-0 rotate-90 opacity-60" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) max-w-(--radix-dropdown-menu-trigger-width)">
                        {field.options.map((option) => (
                          <DropdownMenuItem
                            key={String(option.value)}
                            className="min-w-0 gap-2"
                            onSelect={() => patch(field.key, String(option.value))}
                          >
                            <Check className={cn("size-3.5 shrink-0", selectedValue === String(option.value) ? "opacity-100" : "opacity-0")} />
                            <span className="min-w-0 flex-1 truncate">{option.label}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {field.description ? <p className="text-xs text-muted-foreground">{field.description}</p> : null}
                  </div>
                )
              }
              return (
                <div key={field.key} className="flex flex-col gap-2">
                  <Label htmlFor={`agent-${runtime}-${field.key}`}>{field.label}</Label>
                  <Input
                    id={`agent-${runtime}-${field.key}`}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => patch(field.key, event.currentTarget.value)}
                    placeholder={field.description ?? field.label}
                    spellCheck={false}
                  />
                </div>
              )
            })
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={saving || visibleFields.length === 0}>
            {saving ? t("saving") : tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── AddAgentDialog ────────────────────────────────────────────

function AddAgentDialog({
  open,
  onOpenChange,
  adding,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  adding: boolean
  onAdd: (runtime: string, path: string) => Promise<ConnectorRuntimeScanResponse | null>
}) {
  const t = useTranslations("dashboard.device")
  const tCommon = useTranslations("common")
  const [runtime, setRuntime] = React.useState<(typeof ADD_AGENT_RUNTIME_OPTIONS)[number]["id"]>("codex")
  const [path, setPath] = React.useState("")
  const [scanIssue, setScanIssue] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setRuntime("codex")
    setPath("")
    setScanIssue(null)
  }, [open])

  const submit = async () => {
    setScanIssue(null)
    const response = await onAdd(runtime, path)
    if (!response) return
    const scannedRuntime = response.scanned.runtime ?? runtime
    const attachedAgent = response.runtimeCapabilities.attached[scannedRuntime]
    if (attachedAgent && reportIsHealthy(attachedAgent)) {
      onOpenChange(false)
      return
    }

    const report = response.scanned.report ?? null
    setScanIssue(report ? runtimeIssueReason(report) ?? t("addAgentNotFound") : t("addAgentNotFound"))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("addAgent")}</DialogTitle>
          <DialogDescription>{t("addAgentDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label>{t("agent")}</Label>
            <ToggleGroup
              type="single"
              value={runtime}
              onValueChange={(value) => {
                if (value) setRuntime(value as (typeof ADD_AGENT_RUNTIME_OPTIONS)[number]["id"])
              }}
              className="grid grid-cols-2"
            >
              {ADD_AGENT_RUNTIME_OPTIONS.map((option) => (
                <ToggleGroupItem key={option.id} value={option.id}>
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="add-agent-path">{t("agentPath")}</Label>
            <Input
              id="add-agent-path"
              value={path}
              onChange={(event) => setPath(event.currentTarget.value)}
              placeholder={t("agentPathPlaceholder")}
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">{t("agentPathDescription")}</p>
          </div>

          {scanIssue ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>{t("addAgentFailed")}</AlertTitle>
              <AlertDescription>{scanIssue}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={adding}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={adding}>
            {adding ? t("addingAgent") : t("addAgentAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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
          onCheckedChange={(checked) => onSelectChange(checked === true)}
          aria-label={t("selectSession", { title: session.title ?? t("untitled") })}
        />
      ) : null}
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full border",
          session.status === "running"
            ? "border-emerald-500 bg-emerald-500"
            : session.status === "error"
              ? "border-red-500/70"
              : session.status === "waiting_approval"
                ? "border-amber-400/70"
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

const WORKSPACE_PAGE_SIZE = 6

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

function agentsFromConnector(connector: DeviceConnector | null): AgentRow[] {
  if (!connector) return []
  return Object.entries(connector.runtimeCapabilities.attached)
    .map(([runtime, agent]) => ({
      runtime,
      agent,
      healthy: reportIsHealthy(agent),
      reason: runtimeIssueReason(agent.report),
    }))
    .sort((a, b) => a.runtime.localeCompare(b.runtime))
}

function reportIsHealthy(agent: AttachedAgent) {
  if (agent.report.error) return false
  if (!agent.report.selected) return false
  if (agent.report.execution === "ok") return true
  return !(agent.report.checked ?? []).some((entry) => entry.status === "failed")
}

function runtimeIssueReason(report: RuntimeReport) {
  if (report.error?.message) return report.error.message
  if (report.selected && report.execution === "ok") return null
  return (
    report.checked?.find((entry) => entry.status === "failed")?.reason ??
    report.checked?.find((entry) => entry.status !== "ok")?.reason ??
    null
  )
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

  const [connector, setConnector] = React.useState<(typeof connectors)[number] | null>(null)
  const [workspaces, setWorkspaces] = React.useState<ConnectorWorkspace[]>([])
  const [agents, setAgents] = React.useState<AgentRow[]>([])
  const [sessions, setSessions] = React.useState<DeviceSession[]>([])
  const [loading, setLoading] = React.useState(true)

  const [showAllWorkspaces, setShowAllWorkspaces] = React.useState(false)
  const [sessionTab, setSessionTab] = React.useState<SessionTabId>("active")
  const [configAgent, setConfigAgent] = React.useState<AgentRow | null>(null)
  const [addAgentOpen, setAddAgentOpen] = React.useState(false)
  const [addingAgent, setAddingAgent] = React.useState(false)
  const [agentSettings, setAgentSettings] = React.useState<Record<string, RuntimeSettingsResponse | null>>({})
  const [agentSchemas, setAgentSchemas] = React.useState<Record<string, RuntimeConfigSchema | null>>({})
  const [agentSettingsError, setAgentSettingsError] = React.useState<Record<string, string | null>>({})
  const [savingAgentRuntime, setSavingAgentRuntime] = React.useState<string | null>(null)
  const [removeAgentRuntime, setRemoveAgentRuntime] = React.useState<string | null>(null)
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
      setAgentSettings({})
      setAgentSchemas({})
      setAgentSettingsError({})
      setConfigAgent(null)
      setAddAgentOpen(false)
      setAddingAgent(false)
      setRemoveAgentRuntime(null)
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
    setAgents(agentsFromConnector(currentConnector))
    setLoading(false)
  }, [activeConnectorId, connectors, allSessions])

  const visibleWorkspaces = showAllWorkspaces ? workspaces : workspaces.slice(0, WORKSPACE_PAGE_SIZE)
  const hiddenCount = workspaces.length - WORKSPACE_PAGE_SIZE

  const filteredSessions = sessions.filter((s) => {
    if (sessionTab === "active") return !s.archived
    if (sessionTab === "archived") return s.archived
    return true
  })
  const targetArchiveSelected = sessionTab !== "archived" || Array.from(selectedSessionIds).some((id) => !sessions.find((s) => s.id === id)?.archived)
  const targetArchiveAll = sessionTab !== "archived"
  const allVisibleSelected = filteredSessions.length > 0 && filteredSessions.every((session) => selectedSessionIds.has(session.id))

  React.useEffect(() => {
    if (!authSession?.accessToken || !connector) return
    let cancelled = false
    const runtimes = agents.map((agent) => agent.runtime)
    if (runtimes.length === 0) return
    for (const runtime of runtimes) {
      setAgentSettings((prev) => ({ ...prev, [runtime]: prev[runtime] ?? null }))
      Promise.all([
        dashboardApi.getConnectorAgentSettings(authSession.accessToken, connector.id, runtime),
        dashboardApi.getRuntimeConfigSchema(authSession.accessToken, runtime),
      ])
        .then(([settings, schema]) => {
          if (cancelled) return
          setAgentSettings((prev) => ({ ...prev, [runtime]: settings }))
          setAgentSchemas((prev) => ({ ...prev, [runtime]: schema.schema }))
          setAgentSettingsError((prev) => ({ ...prev, [runtime]: null }))
        })
        .catch((err) => {
          if (cancelled) return
          setAgentSettingsError((prev) => ({
            ...prev,
            [runtime]: err instanceof Error ? err.message : t("agentSettingsFailed"),
          }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [agents, authSession?.accessToken, connector, t])

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

  const saveAgentSettings = async (runtime: string, settings: Record<string, unknown>) => {
    if (!authSession?.accessToken) return
    setSavingAgentRuntime(runtime)
    setAgentSettingsError((prev) => ({ ...prev, [runtime]: null }))
    try {
      const response = await dashboardApi.patchConnectorAgentSettings(authSession.accessToken, connector.id, runtime, settings)
      setAgentSettings((prev) => ({ ...prev, [runtime]: response }))
      refreshData()
    } catch (err) {
      const message = err instanceof Error ? err.message : t("saveAgentSettingsFailed")
      toast.error(message)
      throw err
    } finally {
      setSavingAgentRuntime(null)
    }
  }

  const addAgent = async (runtime: string, path: string) => {
    if (!authSession?.accessToken) return null
    setAddingAgent(true)
    try {
      const response = await dashboardApi.scanConnectorRuntime(
        authSession.accessToken,
        connector.id,
        runtime,
        path,
      )
      const nextConnector = { ...connector, runtimeCapabilities: response.runtimeCapabilities }
      setConnector(nextConnector)
      setAgents(agentsFromConnector(nextConnector))
      refreshData()
      const scannedRuntime = response.scanned.runtime ?? runtime
      const attachedAgent = response.runtimeCapabilities.attached[scannedRuntime]
      if (attachedAgent && reportIsHealthy(attachedAgent)) {
        toast.success(t("addAgentSuccess", { name: scannedRuntime }))
      }
      return response
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("addAgentFailed"))
      return null
    } finally {
      setAddingAgent(false)
    }
  }

  const removeAgent = async () => {
    if (!authSession?.accessToken || !removeAgentRuntime) return
    try {
      const response = await dashboardApi.deleteConnectorRuntime(authSession.accessToken, connector.id, removeAgentRuntime)
      setConnector((prev) => prev ? { ...prev, runtimeCapabilities: response.runtimeCapabilities } : prev)
      setAgents((prev) => prev.filter((agent) => agent.runtime !== removeAgentRuntime))
      setSessions((prev) => prev.filter((session) => session.runtime !== removeAgentRuntime))
      setRemoveAgentRuntime(null)
      refreshData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("removeAgentFailed"))
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
              onClick={() => {
                if (connector.status === "offline") {
                  void handleRevoke()
                } else {
                  setRevokeOpen(true)
                }
              }}
              disabled={tokenActionBusy}
            >
              <KeyRound />
              {tokenActionBusy ? t("preparing") : connector.status === "offline" ? t("setup") : t("revoke")}
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

        {/* Agents */}
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {t("agents")}
            </h2>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAddAgentOpen(true)}
              disabled={connector.status !== "online"}
            >
              <Plus />
              {t("addAgent")}
            </Button>
          </div>

          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noAgents")}</p>
          ) : (
            <TooltipProvider>
              <div className="flex flex-col gap-0.5">
                {agents.map((agent) => (
                  <div
                    key={agent.runtime}
                    className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/30"
                  >
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        agent.healthy ? "bg-emerald-500" : "bg-destructive",
                      )}
                    />
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="truncate text-sm font-medium">{agent.runtime}</span>
                      {agent.reason ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="destructive" className="shrink-0 gap-1">
                              <AlertCircle className="size-3" />
                              {t("agentIssue")}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-sm">
                            {agent.reason}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </span>
                    <div className="flex items-center gap-0.5">
                      <Button
                        type="button"
                        onClick={() => setConfigAgent(agent)}
                        variant="ghost"
                        size="icon"
                        aria-label={t("configureAgent", { name: agent.runtime })}
                      >
                        <Settings />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          setRemoveAgentRuntime(agent.runtime)
                        }}
                        aria-label={t("removeAgent", { name: agent.runtime })}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                ))}
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
              <div className="grid grid-cols-2 gap-2">
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
                const nextWorkspace = workspaces[WORKSPACE_PAGE_SIZE]
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
            onValueChange={(value) => {
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
                onCheckedChange={(checked) => toggleAllVisible(checked === true)}
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

      {/* Agent config dialog */}
      {configAgent && (
        <AgentConfigDialog
          runtime={configAgent.runtime}
          schema={agentSchemas[configAgent.runtime] ?? null}
          settings={agentSettings[configAgent.runtime]?.settings ?? agentSettings[configAgent.runtime]?.runtimeSettings ?? null}
          error={agentSettingsError[configAgent.runtime] ?? null}
          saving={savingAgentRuntime === configAgent.runtime}
          open={!!configAgent}
          onOpenChange={(v) => { if (!v) setConfigAgent(null) }}
          onSave={(settings) => saveAgentSettings(configAgent.runtime, settings)}
        />
      )}

      <AddAgentDialog
        open={addAgentOpen}
        onOpenChange={setAddAgentOpen}
        adding={addingAgent}
        onAdd={addAgent}
      />

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

      <AlertDialog open={removeAgentRuntime !== null} onOpenChange={(open) => {
        if (!open) setRemoveAgentRuntime(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeAgentTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeAgentDescription", { name: removeAgentRuntime ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void removeAgent()}
            >
              {t("removeAgentAction")}
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
