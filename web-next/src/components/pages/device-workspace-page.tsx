"use client"

import * as React from "react"
import { ChevronLeft, FolderOpen, Plus } from "lucide-react"
import type { Layout } from "react-resizable-panels"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/components/workspace-context"
import { FilesPanelBody } from "@/components/panels/files-panel"
import { TerminalPanelBody } from "@/components/panels/terminal-panel"
import { useAuth } from "@/components/auth/auth-context"
import { useTranslations } from "next-intl"

type WorkspaceSummary = {
  path: string
  name: string
  sessionCount: number
  lastActiveAt: string | null
}

type WorkspaceSession = {
  connectorId: string
  cwd?: string | null
  updatedAt?: string | null
  sortAt?: string | null
  lastActivityAt?: string | null
  lastItemAt?: string | null
}

// ── WorkspaceListItem ──────────────────────────────────────────

function WorkspaceListItem({
  workspace,
  isActive,
  onClick,
}: {
  workspace: WorkspaceSummary
  isActive: boolean
  onClick: () => void
}) {
  const t = useTranslations("dashboard.deviceWorkspace")
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <FolderOpen className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight">{workspace.name}</p>
        <p className="truncate text-xs opacity-60">{workspace.path}</p>
        <p className="text-xs opacity-50">
          {t("sessionCount", { count: workspace.sessionCount })}
        </p>
      </div>
    </button>
  )
}

// ── DeviceWorkspacePage ────────────────────────────────────────

const WORKSPACE_LAYOUT: Layout = {
  "workspace-list": 22,
  "workspace-terminal": 43,
  "workspace-files": 35,
}
const WORKSPACE_LAYOUT_KEY = "aa-device-workspace-layout"
const WORKSPACE_PANEL_IDS = Object.keys(WORKSPACE_LAYOUT)

function readWorkspaceLayout(): Layout {
  if (typeof window === "undefined") return WORKSPACE_LAYOUT
  try {
    const raw = window.localStorage.getItem(WORKSPACE_LAYOUT_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== "object") return WORKSPACE_LAYOUT
    const next: Layout = {}
    for (const id of WORKSPACE_PANEL_IDS) {
      const value = (parsed as Record<string, unknown>)[id]
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return WORKSPACE_LAYOUT
      next[id] = value
    }
    return next
  } catch {
    return WORKSPACE_LAYOUT
  }
}

function writeWorkspaceLayout(layout: Layout) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    // Resizing should continue even if storage is unavailable.
  }
}

function workspaceName(path: string) {
  const normalized = path.trim() || "~"
  if (normalized === "~" || normalized === "." || normalized === "/") return normalized
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized
}

function timeValue(value: string | null) {
  return value ? new Date(value).getTime() : 0
}

function sessionActivityAt(session: WorkspaceSession) {
  return session.sortAt ?? session.lastActivityAt ?? session.lastItemAt ?? session.updatedAt ?? null
}

function workspacesFromSessions(sessions: WorkspaceSession[]): WorkspaceSummary[] {
  const byPath = new Map<string, WorkspaceSummary>()
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
      name: workspaceName(path),
      sessionCount: 1,
      lastActiveAt: activeAt,
    })
  }
  return Array.from(byPath.values()).sort((a, b) => timeValue(b.lastActiveAt) - timeValue(a.lastActiveAt))
}

export function DeviceWorkspacePage() {
  const t = useTranslations("dashboard.deviceWorkspace")
  const { session: authSession } = useAuth()
  const {
    activeConnectorId,
    activeWorkspacePath,
    connectors,
    sessions: allSessions,
    navigateToDevice,
    navigateToWorkspace,
  } = useWorkspace()

  const connector = React.useMemo(
    () => connectors.find((item) => item.id === activeConnectorId) ?? null,
    [activeConnectorId, connectors],
  )
  const connectorSessions = React.useMemo(
    () => allSessions.filter((session) => session.connectorId === activeConnectorId),
    [activeConnectorId, allSessions],
  )
  const workspaces = React.useMemo(() => workspacesFromSessions(connectorSessions), [connectorSessions])
  const sessions = React.useMemo(
    () => connectorSessions.filter((session) => (session.cwd || "~") === activeWorkspacePath),
    [activeWorkspacePath, connectorSessions],
  )

  const defaultLayout = React.useMemo(readWorkspaceLayout, [])

  if (!activeConnectorId || !activeWorkspacePath) return null

  return (
    <ResizablePanelGroup
      direction="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={writeWorkspaceLayout}
      className="h-svh w-full"
    >

      {/* ── Panel 1: Workspace list ── */}
      <ResizablePanel id="workspace-list" defaultSize="22%" minSize="18%" maxSize="32%">
        <div className="flex h-full flex-col border-r border-border bg-sidebar">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-3">
            <button
              type="button"
              onClick={() => navigateToDevice(activeConnectorId)}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              aria-label={t("backToDevice")}
            >
              <ChevronLeft className="size-4" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{connector?.name ?? activeConnectorId}</p>
              <p className="text-xs text-muted-foreground">
                {t("sessionCount", { count: sessions.length })}
              </p>
            </div>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              aria-label={t("addWorkspace")}
            >
              <Plus className="size-3.5" />
            </button>
          </div>

          {/* List */}
          <ScrollArea className="flex-1">
            {workspaces.map((ws) => (
              <WorkspaceListItem
                key={ws.path}
                workspace={ws}
                isActive={ws.path === activeWorkspacePath}
                onClick={() => navigateToWorkspace(activeConnectorId, ws.path)}
              />
            ))}
          </ScrollArea>
        </div>
      </ResizablePanel>

      <ResizableHandle />

      {/* ── Panel 2: Terminal ── */}
      <ResizablePanel id="workspace-terminal" defaultSize="43%" minSize="28%">
        <div className="h-full min-h-0 overflow-hidden">
          <TerminalPanelBody
            token={authSession?.accessToken}
            connectorId={activeConnectorId}
            root={activeWorkspacePath}
          />
        </div>
      </ResizablePanel>

      <ResizableHandle />

      {/* ── Panel 3: Files ── */}
      <ResizablePanel id="workspace-files" defaultSize="35%" minSize="24%">
        <div className="h-full min-h-0 overflow-hidden">
          <FilesPanelBody
            token={authSession?.accessToken}
            connectorId={activeConnectorId}
            root={activeWorkspacePath}
          />
        </div>
      </ResizablePanel>

    </ResizablePanelGroup>
  )
}
