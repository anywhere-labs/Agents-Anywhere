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
  Circle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { LoadingState } from "@/components/loading-state"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import {
  type ConnectorWorkspace,
  type AgentConfig,
  type SessionView,
} from "@/lib/demo-api"
import { useWorkspace } from "@/components/workspace-context"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import { PairDeviceDialog } from "@/components/pair-device-dialog"
import type { ConnectorRevokeResponse } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

type DeviceConnector = ReturnType<typeof useWorkspace>["connectors"][number]

// ── Config options ─────────────────────────────────────────────

const PERMISSION_OPTIONS = [
  { value: "ask_for_approval", labelKey: "permissionAskForApproval" },
  { value: "auto_edit", labelKey: "permissionAutoEdit" },
  { value: "full_auto", labelKey: "permissionFullAuto" },
]
const MODEL_OPTIONS = [
  { value: "codex-mini-latest", label: "codex-mini-latest" },
  { value: "o4-mini", label: "o4-mini" },
  { value: "o3", label: "o3" },
  { value: "claude-opus-4-5", label: "claude-opus-4-5" },
  { value: "claude-sonnet-4-5", label: "claude-sonnet-4-5" },
  { value: "gpt-5-mini", label: "gpt-5-mini" },
]
const EFFORT_OPTIONS = [
  { value: "low", labelKey: "effortLow" },
  { value: "medium", labelKey: "effortMedium" },
  { value: "high", labelKey: "effortHigh" },
]
const DEVICE_STATUS_LABEL_KEYS = {
  online: "online",
  offline: "offline",
} as const

// ── AgentConfigDialog ──────────────────────────────────────────

function AgentConfigDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: AgentConfig
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const t = useTranslations("dashboard.device")
  const tCommon = useTranslations("common")
  const [permissionMode, setPermissionMode] = React.useState(agent.defaultPermissionMode)
  const [model, setModel] = React.useState(agent.defaultModel)
  const [effort, setEffort] = React.useState(agent.defaultEffort)

  React.useEffect(() => {
    if (open) {
      setPermissionMode(agent.defaultPermissionMode)
      setModel(agent.defaultModel)
      setEffort(agent.defaultEffort)
    }
  }, [open, agent])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{agent.name}</DialogTitle>
          <DialogDescription>{t("defaultConfiguration")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label>{t("defaultPermissionMode")}</Label>
            <Select value={permissionMode} onValueChange={setPermissionMode}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{t(o.labelKey)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label>{t("defaultModel")}</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="col-span-2 flex flex-col gap-2">
            <Label>{t("defaultEffort")}</Label>
            <Select value={effort} onValueChange={setEffort}>
              <SelectTrigger className="w-1/2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{t(o.labelKey)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>
            {tCommon("done")}
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
    <button
      type="button"
      onClick={onOpen}
      className="group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/40"
    >
      <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{workspace.name}</p>
        <p className="text-xs text-muted-foreground">
          {t("sessionCount", { count: workspace.sessionCount })}
        </p>
      </div>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); onNewSession() }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onNewSession() } }}
        aria-label={t("newSession")}
        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      >
        <Plus className="size-3.5" />
      </span>
    </button>
  )
}

// ── Session row ────────────────────────────────────────────────

type SessionTabId = "active" | "archived" | "all"
const SESSION_TABS: { value: SessionTabId; labelKey: "active" | "archived" | "all" }[] = [
  { value: "active", labelKey: "active" },
  { value: "archived", labelKey: "archived" },
  { value: "all", labelKey: "all" },
]

function SessionRow({ session, onClick }: { session: SessionView; onClick: () => void }) {
  const t = useTranslations("dashboard.device")
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-accent/40"
    >
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
      <span className="flex-1 truncate text-sm">{session.title ?? t("untitled")}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{session.updatedAt}</span>
    </button>
  )
}

// ── DevicePage ─────────────────────────────────────────────────

const WORKSPACE_PAGE_SIZE = 6

function workspacesFromSessions(sessions: SessionView[]): ConnectorWorkspace[] {
  const byPath = new Map<string, ConnectorWorkspace>()
  for (const session of sessions) {
    const path = session.cwd || "~"
    const existing = byPath.get(path)
    if (existing) {
      existing.sessionCount += 1
      continue
    }
    byPath.set(path, {
      path,
      name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
      sessionCount: 1,
      lastActiveAt: session.updatedAt,
    })
  }
  return Array.from(byPath.values()).sort((a, b) => b.sessionCount - a.sessionCount)
}

function agentsFromConnector(connector: DeviceConnector | null): AgentConfig[] {
  if (!connector) return []
  return Object.entries(connector.runtimeCapabilities.attached).map(([runtime, attached]) => ({
    name: runtime,
    defaultPermissionMode: "ask_for_approval",
    defaultModel: attached.report.selected?.version ?? runtime,
    defaultEffort: "medium",
  }))
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
  const [agents, setAgents] = React.useState<AgentConfig[]>([])
  const [sessions, setSessions] = React.useState<SessionView[]>([])
  const [loading, setLoading] = React.useState(true)

  const [showAllWorkspaces, setShowAllWorkspaces] = React.useState(false)
  const [sessionTab, setSessionTab] = React.useState<SessionTabId>("active")
  const [configAgent, setConfigAgent] = React.useState<AgentConfig | null>(null)
  const [revokeOpen, setRevokeOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [setupCredential, setSetupCredential] = React.useState<ConnectorRevokeResponse | null>(null)
  const [setupOpen, setSetupOpen] = React.useState(false)
  const [tokenActionBusy, setTokenActionBusy] = React.useState(false)
  const [tokenActionError, setTokenActionError] = React.useState<string | null>(null)
  const [editingName, setEditingName] = React.useState(false)
  const [nameDraft, setNameDraft] = React.useState("")
  const [renameError, setRenameError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!activeConnectorId) return
    setLoading(true)
    setShowAllWorkspaces(false)
    setSessionTab("active")

    const currentConnector = connectors.find((item) => item.id === activeConnectorId) ?? null
    const connectorSessions = allSessions.filter((item) => item.connectorId === activeConnectorId)
    setConnector(currentConnector)
    setNameDraft(currentConnector?.name ?? "")
    setEditingName(false)
    setRenameError(null)
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

  if (loading || !connector) {
    return (
      <LoadingState className="flex-1" />
    )
  }

  const handleRevoke = async () => {
    if (!authSession?.accessToken) return
    setTokenActionBusy(true)
    setTokenActionError(null)
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
      setTokenActionError(err instanceof Error ? err.message : t("setupFailed"))
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
      setRenameError(null)
      return
    }

    setRenameError(null)
    try {
      const result = await dashboardApi.updateConnector(authSession.accessToken, connector.id, { name: nextName })
      setConnector(result.connector)
      setNameDraft(result.connector.name)
      setEditingName(false)
      refreshData()
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : t("renameFailed"))
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

  return (
    <ScrollArea className="flex-1">
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
                  setRenameError(null)
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
              className="gap-1.5"
              onClick={() => {
                setTokenActionError(null)
                if (connector.status === "offline") {
                  void handleRevoke()
                } else {
                  setRevokeOpen(true)
                }
              }}
              disabled={tokenActionBusy}
            >
              <KeyRound className="size-3.5" />
              {tokenActionBusy ? t("preparing") : connector.status === "offline" ? t("setup") : t("revoke")}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
        {renameError && <p className="mt-3 text-sm text-destructive">{renameError}</p>}
        {tokenActionError && <p className="mt-3 text-sm text-destructive">{tokenActionError}</p>}

        <Separator className="my-6" />

        {/* Agents */}
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {t("agents")}
            </h2>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </div>

          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noAgents")}</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {agents.map((agent) => (
                <div
                  key={agent.name}
                  className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/30"
                >
                  <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
                  <span className="flex-1 text-sm font-medium">{agent.name}</span>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => setConfigAgent(agent)}
                      className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={t("configureAgent", { name: agent.name })}
                    >
                      <Settings className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                      aria-label={t("removeAgent", { name: agent.name })}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Workspaces */}
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {t("workspaces")}
            </h2>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </button>
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
                    onNewSession={() => {}}
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
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <button type="button" className="transition-colors hover:text-foreground">
                {t("select")}
              </button>
              <span aria-hidden>·</span>
              <button type="button" className="transition-colors hover:text-foreground">
                {t("archiveAll")}
              </button>
            </div>
          </div>

          <div className="mb-3 flex items-center gap-1">
            {SESSION_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setSessionTab(tab.value)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  sessionTab === tab.value
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                  {t(tab.labelKey)}
              </button>
            ))}
          </div>

          {filteredSessions.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("noSessions")}</p>
          ) : (
            <div className="flex flex-col">
              {filteredSessions.map((s) => (
                <SessionRow key={s.id} session={s} onClick={() => openSession(s.id)} />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Agent config dialog */}
      {configAgent && (
        <AgentConfigDialog
          agent={configAgent}
          open={!!configAgent}
          onOpenChange={(v) => { if (!v) setConfigAgent(null) }}
        />
      )}

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
            {tokenActionError && <p className="text-sm text-destructive">{tokenActionError}</p>}
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
    </ScrollArea>
  )
}
