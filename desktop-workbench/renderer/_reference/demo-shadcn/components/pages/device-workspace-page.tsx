"use client"

import * as React from "react"
import { ChevronLeft, FolderOpen, FolderTree, Plus, SquareTerminal } from "lucide-react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { cn } from "@/lib/utils"
import {
  type ConnectorView,
  type ConnectorWorkspace,
  type SessionView,
  getConnector,
  listConnectorWorkspaces,
  listWorkspaceSessions,
} from "@/lib/api"
import { useWorkspace } from "@/components/workspace-context"
import { PanelHeader } from "@/components/panels/panel-header"
import { FilesPanelBody } from "@/components/panels/files-panel"
import { TerminalPanelBody } from "@/components/panels/terminal-panel"

// ── WorkspaceListItem ──────────────────────────────────────────

function WorkspaceListItem({
  workspace,
  isActive,
  onClick,
}: {
  workspace: ConnectorWorkspace
  isActive: boolean
  onClick: () => void
}) {
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
          {workspace.sessionCount === 1 ? "1 session" : `${workspace.sessionCount} sessions`}
        </p>
      </div>
    </button>
  )
}

// ── DeviceWorkspacePage ────────────────────────────────────────

export function DeviceWorkspacePage() {
  const {
    activeConnectorId,
    activeWorkspacePath,
    navigateToDevice,
    navigateToWorkspace,
  } = useWorkspace()

  const [connector, setConnector] = React.useState<ConnectorView | null>(null)
  const [workspaces, setWorkspaces] = React.useState<ConnectorWorkspace[]>([])
  const [sessions, setSessions] = React.useState<SessionView[]>([])

  React.useEffect(() => {
    if (!activeConnectorId) return
    Promise.all([
      getConnector("mock-token", activeConnectorId),
      listConnectorWorkspaces("mock-token", activeConnectorId),
    ]).then(([c, w]) => {
      setConnector(c)
      setWorkspaces(w.workspaces)
    })
  }, [activeConnectorId])

  React.useEffect(() => {
    if (!activeConnectorId || !activeWorkspacePath) return
    listWorkspaceSessions("mock-token", activeConnectorId, activeWorkspacePath).then((res) => {
      setSessions(res.sessions)
    })
  }, [activeConnectorId, activeWorkspacePath])

  if (!activeConnectorId || !activeWorkspacePath) return null

  return (
    <ResizablePanelGroup direction="horizontal" className="h-svh w-full">

      {/* ── Panel 1: Workspace list ── */}
      <ResizablePanel defaultSize={18} minSize={12} maxSize={35}>
        <div className="flex h-full flex-col border-r border-border bg-sidebar">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-3">
            <button
              type="button"
              onClick={() => navigateToDevice(activeConnectorId)}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              aria-label="Back to device"
            >
              <ChevronLeft className="size-4" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{connector?.name ?? activeConnectorId}</p>
              <p className="text-xs text-muted-foreground">Workspaces</p>
            </div>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              aria-label="Add workspace"
            >
              <Plus className="size-3.5" />
            </button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {workspaces.map((ws) => (
              <WorkspaceListItem
                key={ws.path}
                workspace={ws}
                isActive={ws.path === activeWorkspacePath}
                onClick={() => navigateToWorkspace(activeConnectorId, ws.path)}
              />
            ))}
          </div>
        </div>
      </ResizablePanel>

      <ResizableHandle withHandle />

      {/* ── Panel 2: Terminal ── */}
      <ResizablePanel defaultSize={50} minSize={20}>
        <div className="flex h-full flex-col">
          <PanelHeader
            icon={SquareTerminal}
            title="Shell"
            onRefresh={() => {}}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <TerminalPanelBody />
          </div>
        </div>
      </ResizablePanel>

      <ResizableHandle withHandle />

      {/* ── Panel 3: Files ── */}
      <ResizablePanel defaultSize={32} minSize={15}>
        <div className="flex h-full flex-col">
          <PanelHeader
            icon={FolderTree}
            title="Files"
            onRefresh={() => {}}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <FilesPanelBody />
          </div>
        </div>
      </ResizablePanel>

    </ResizablePanelGroup>
  )
}
