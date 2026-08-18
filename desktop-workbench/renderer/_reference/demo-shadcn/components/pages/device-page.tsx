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
import { Separator } from "@/components/ui/separator"
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
  type ConnectorView,
  type ConnectorWorkspace,
  type AgentConfig,
  type SessionView,
  getConnector,
  revokeConnector,
  deleteConnector,
  listConnectorWorkspaces,
  getAgentConfigs,
  updateAgentConfig,
  listConnectorSessions,
} from "@/lib/api"
import { useWorkspace } from "@/components/workspace-context"

// ── Config options ─────────────────────────────────────────────

const PERMISSION_OPTIONS = [
  { value: "ask_for_approval", label: "Ask for approval" },
  { value: "auto_edit", label: "Auto edit" },
  { value: "full_auto", label: "Full auto" },
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
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
]

// ── AgentConfigDialog ──────────────────────────────────────────

function AgentConfigDialog({
  connectorId,
  agent,
  open,
  onOpenChange,
  onSaved,
}: {
  connectorId: string
  agent: AgentConfig
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: (updated: AgentConfig) => void
}) {
  const [permissionMode, setPermissionMode] = React.useState(agent.defaultPermissionMode)
  const [model, setModel] = React.useState(agent.defaultModel)
  const [effort, setEffort] = React.useState(agent.defaultEffort)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setPermissionMode(agent.defaultPermissionMode)
      setModel(agent.defaultModel)
      setEffort(agent.defaultEffort)
    }
  }, [open, agent])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await updateAgentConfig("mock-token", connectorId, agent.name, {
        defaultPermissionMode: permissionMode,
        defaultModel: model,
        defaultEffort: effort,
      })
      onSaved(updated)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{agent.name}</DialogTitle>
          <DialogDescription>Default configuration</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label>Default permission mode</Label>
            <Select value={permissionMode} onValueChange={setPermissionMode}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Default model</Label>
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
            <Label>Default effort</Label>
            <Select value={effort} onValueChange={setEffort}>
              <SelectTrigger className="w-1/2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
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
          {workspace.sessionCount === 1 ? "1 session" : `${workspace.sessionCount} sessions`}
        </p>
      </div>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); onNewSession() }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onNewSession() } }}
        aria-label="New session"
        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      >
        <Plus className="size-3.5" />
      </span>
    </button>
  )
}

// ── Session row ────────────────────────────────────────────────

type SessionTabId = "active" | "archived" | "all"
const SESSION_TABS: { value: SessionTabId; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
]

function SessionRow({ session, onClick }: { session: SessionView; onClick: () => void }) {
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
      <span className="flex-1 truncate text-sm">{session.title ?? "(untitled)"}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{session.updatedAt}</span>
    </button>
  )
}

// ── DevicePage ─────────────────────────────────────────────────

const WORKSPACE_PAGE_SIZE = 6

export function DevicePage() {
  const { activeConnectorId, navigateToWorkspace, openSession, goHome } = useWorkspace()

  const [connector, setConnector] = React.useState<ConnectorView | null>(null)
  const [workspaces, setWorkspaces] = React.useState<ConnectorWorkspace[]>([])
  const [agents, setAgents] = React.useState<AgentConfig[]>([])
  const [sessions, setSessions] = React.useState<SessionView[]>([])
  const [loading, setLoading] = React.useState(true)

  const [showAllWorkspaces, setShowAllWorkspaces] = React.useState(false)
  const [sessionTab, setSessionTab] = React.useState<SessionTabId>("active")
  const [configAgent, setConfigAgent] = React.useState<AgentConfig | null>(null)
  const [revokeOpen, setRevokeOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  React.useEffect(() => {
    if (!activeConnectorId) return
    setLoading(true)
    setShowAllWorkspaces(false)
    setSessionTab("active")
    Promise.all([
      getConnector("mock-token", activeConnectorId),
      listConnectorWorkspaces("mock-token", activeConnectorId),
      getAgentConfigs("mock-token", activeConnectorId),
      listConnectorSessions("mock-token", activeConnectorId),
    ]).then(([c, w, a, s]) => {
      setConnector(c)
      setWorkspaces(w.workspaces)
      setAgents(a.agents)
      setSessions(s.sessions)
    }).finally(() => setLoading(false))
  }, [activeConnectorId])

  const visibleWorkspaces = showAllWorkspaces ? workspaces : workspaces.slice(0, WORKSPACE_PAGE_SIZE)
  const hiddenCount = workspaces.length - WORKSPACE_PAGE_SIZE

  const filteredSessions = sessions.filter((s) => {
    if (sessionTab === "active") return !s.archived
    if (sessionTab === "archived") return s.archived
    return true
  })

  if (loading || !connector) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  const handleRevoke = async () => {
    await revokeConnector("mock-token", connector.id)
    setConnector((prev) => (prev ? { ...prev, status: "offline" } : prev))
    setRevokeOpen(false)
  }

  const handleDelete = async () => {
    await deleteConnector("mock-token", connector.id)
    setDeleteOpen(false)
    goHome()
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">

        {/* Header */}
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{connector.name}</h1>
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
              {connector.status}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setRevokeOpen(true)}
            >
              <KeyRound className="size-3.5" />
              Revoke
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

        <Separator className="my-6" />

        {/* Agents */}
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Agents
            </h2>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </div>

          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents configured.</p>
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
                      aria-label={`Configure ${agent.name}`}
                    >
                      <Settings className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                      aria-label={`Remove ${agent.name}`}
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
              Workspaces
            </h2>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </div>

          {workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">No workspaces yet.</p>
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

              {!showAllWorkspaces && hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => navigateToWorkspace(connector.id, workspaces[WORKSPACE_PAGE_SIZE].path)}
                  className="mt-3 flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Show all{" "}
                  <span className="mx-0.5 text-foreground">{hiddenCount} more</span>
                  <ChevronRight className="size-3.5" />
                </button>
              )}
            </>
          )}
        </section>

        {/* Sessions */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Sessions
            </h2>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <button type="button" className="transition-colors hover:text-foreground">
                Select
              </button>
              <span aria-hidden>·</span>
              <button type="button" className="transition-colors hover:text-foreground">
                Archive all
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
                {tab.label}
              </button>
            ))}
          </div>

          {filteredSessions.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No sessions.</p>
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
          connectorId={connector.id}
          agent={configAgent}
          open={!!configAgent}
          onOpenChange={(v) => { if (!v) setConfigAgent(null) }}
          onSaved={(updated) => {
            setAgents((prev) => prev.map((a) => (a.name === updated.name ? updated : a)))
            setConfigAgent(null)
          }}
        />
      )}

      {/* Revoke confirm */}
      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke token?</AlertDialogTitle>
            <AlertDialogDescription>
              This will invalidate the current token for <strong>{connector.name}</strong>. The
              device will go offline until it reconnects with a new token.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevoke}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete device?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove <strong>{connector.name}</strong> and all its associated
              data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
