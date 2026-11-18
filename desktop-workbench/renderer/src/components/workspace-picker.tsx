"use client"

import * as React from "react"
import {
  Folder,
  FolderOpen,
  ChevronDown,
  Plus,
  Check,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { useWorkspace } from "@/components/workspace-context"
import { useAuth } from "@/components/auth/auth-context"
import { OverflowMarquee } from "@/components/sidebar/overflow-marquee"
import { dashboardApi } from "@/features/dashboard/api"
import { useTranslations } from "next-intl"
import { FileBrowserDialog } from "@/components/workspace-file-browser-dialog"
import { Separator } from "@/components/ui/separator"
import { findWorkspaceProject, workspaceName, workspacePathKey } from "@/features/dashboard/project-workspaces"

// ── Types ─────────────────────────────────────────────────────

type WorkspaceEntry = {
  label: string
  path: string
  connectorId?: string
  projectId?: string
}

export type WorkspaceSelection = WorkspaceEntry

const DEFAULT_WORKSPACE_TIMEOUT_MS = 8_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("request timed out")), ms)
    promise.then(resolve, reject).finally(() => window.clearTimeout(timeout))
  })
}

// ── Workspace picker ───────────────────────────────────────────

export function WorkspacePicker({
  connectorId,
  value,
  onChange,
  includeProjects = false,
  onCreateProject,
  disabled = false,
}: {
  connectorId?: string
  value?: WorkspaceSelection | null
  onChange?: (workspace: WorkspaceSelection | null) => void
  includeProjects?: boolean
  onCreateProject?: () => void
  disabled?: boolean
} = {}) {
  const { session: authSession } = useAuth()
  const { connectors, projects, sessions, openPairDeviceDialog } = useWorkspace()
  const t = useTranslations("dashboard.workspacePicker")

  // Pick first online connector for FS browsing
  const activeConnector = connectorId
    ? connectors.find((c) => c.id === connectorId)
    : connectors.find((c) => c.status === "online") ?? connectors[0]
  const activeConnectorId = activeConnector?.id
  const hasOnlineConnector = activeConnector?.status === "online"
  const [defaultResult, setDefaultResult] = React.useState({ connectorId: "", path: "" })
  const defaultPath = defaultResult.connectorId === activeConnectorId ? defaultResult.path : ""
  const [resolvingDefaultPath, setResolvingDefaultPath] = React.useState(false)

  React.useEffect(() => {
    setDefaultResult({ connectorId: activeConnectorId ?? "", path: "" })
    if (!authSession?.accessToken || !activeConnectorId || !hasOnlineConnector) {
      setResolvingDefaultPath(false)
      return
    }
    let cancelled = false
    setResolvingDefaultPath(true)
    withTimeout(
      dashboardApi.connectorFsList(authSession.accessToken, activeConnectorId, {}),
      DEFAULT_WORKSPACE_TIMEOUT_MS,
    )
      .then((response) => {
        if (cancelled) return
        setDefaultResult({ connectorId: activeConnectorId, path: response.result.path })
      })
      .catch(() => {
        // Keep the directory unset until the device provides a usable default or the user selects one.
      })
      .finally(() => {
        if (!cancelled) setResolvingDefaultPath(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeConnectorId, authSession?.accessToken, hasOnlineConnector])

  // Derive recent unique workspaces for the active connector from session CWDs.
  const recentWorkspaces = React.useMemo<WorkspaceEntry[]>(() => {
    if (!activeConnectorId) return []
    const seen = new Set<string>(defaultPath ? [workspacePathKey(defaultPath, activeConnector?.deviceOs)] : [])
    const result: WorkspaceEntry[] = []
    for (const s of sessions) {
      if (s.connectorId !== activeConnectorId) continue
      if (!s.cwd) continue
      const key = workspacePathKey(s.cwd, activeConnector?.deviceOs)
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ label: workspaceName(s.cwd), path: s.cwd, connectorId: s.connectorId })
    }
    for (const project of projects) {
      if (project.connectorId !== activeConnectorId) continue
      const key = workspacePathKey(project.workspacePath, activeConnector?.deviceOs)
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ label: workspaceName(project.workspacePath), path: project.workspacePath, connectorId: activeConnectorId })
    }
    return result
  }, [activeConnectorId, activeConnector?.deviceOs, projects, defaultPath, sessions])

  const availableProjects = React.useMemo(
    () => includeProjects
      ? projects.filter((project) => project.connectorId === activeConnectorId)
      : [],
    [activeConnectorId, includeProjects, projects],
  )

  const defaultWorkspace: WorkspaceEntry = React.useMemo(() => {
    const project = activeConnectorId && defaultPath
      ? findWorkspaceProject(availableProjects, activeConnectorId, defaultPath, activeConnector?.deviceOs)
      : undefined
    if (project) {
      return { label: project.name, path: project.workspacePath, connectorId: project.connectorId, projectId: project.id }
    }
    return { label: t("default"), path: defaultPath, connectorId: activeConnectorId }
  }, [activeConnectorId, activeConnector?.deviceOs, availableProjects, defaultPath, t])

  const [internalWorkspace, setInternalWorkspace] = React.useState<WorkspaceEntry>(defaultWorkspace)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [hoveredProjectId, setHoveredProjectId] = React.useState<string | null>(null)
  const valueBelongsToActiveConnector =
    Boolean(value?.path) && value?.connectorId === activeConnectorId
  const workspace = valueBelongsToActiveConnector
    ? value!
    : internalWorkspace.connectorId === activeConnectorId ? internalWorkspace : defaultWorkspace

  const updateWorkspace = React.useCallback(
    (next: WorkspaceEntry) => {
      if (!value) setInternalWorkspace(next)
      onChange?.(next)
    },
    [onChange, value],
  )

  React.useEffect(() => {
    if (value?.connectorId && activeConnectorId && value.connectorId !== activeConnectorId) {
      setInternalWorkspace({ label: t("default"), path: "", connectorId: activeConnectorId })
    }
    if (!defaultWorkspace.path) return
    if (!value?.path) {
      setInternalWorkspace(defaultWorkspace)
      onChange?.(defaultWorkspace)
    } else if (activeConnectorId && value.connectorId !== activeConnectorId) {
      onChange?.(defaultWorkspace)
    }
  }, [activeConnectorId, defaultWorkspace, onChange, value])

  const selectedProject = includeProjects && activeConnectorId
    ? findWorkspaceProject(availableProjects, activeConnectorId, workspace.path, activeConnector?.deviceOs)
    : null
  const isProject = Boolean(selectedProject)
  const isDefault = Boolean(!isProject && defaultWorkspace.path && workspace.path === defaultWorkspace.path)

  const workspaceMenuGroups = (
    <>
      <DropdownMenuLabel>{t("workspaces")}</DropdownMenuLabel>
      <DropdownMenuGroup>
        <DropdownMenuItem
          className="gap-2.5"
          disabled={!defaultWorkspace.path}
          onSelect={() => updateWorkspace(defaultWorkspace)}
        >
          <Folder />
          <div className="flex min-w-0 flex-1 flex-col">
            <span>{t("default")}</span>
            <span className="truncate code-mono text-xs text-muted-foreground">
              {defaultWorkspace.path || (resolvingDefaultPath ? t("loading") : "")}
            </span>
          </div>
          {resolvingDefaultPath ? <Spinner className="ml-auto shrink-0 text-muted-foreground" /> : null}
          {isDefault ? <Check className="ml-auto shrink-0" /> : null}
        </DropdownMenuItem>

        <DropdownMenuItem className="gap-2.5" onSelect={() => setDialogOpen(true)}>
          <Plus />
          <span>{t("browseFilesystem")}</span>
        </DropdownMenuItem>
      </DropdownMenuGroup>

      {recentWorkspaces.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <ScrollArea className="max-h-56" viewportProps={{ className: "max-h-56" }}>
            <DropdownMenuGroup>
              {recentWorkspaces.map((ws) => (
                <DropdownMenuItem
                  key={ws.path}
                  className="gap-2.5"
                  onSelect={() => updateWorkspace(ws)}
                >
                  <Folder />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{ws.label}</span>
                    <span className="truncate code-mono text-xs text-muted-foreground">{ws.path}</span>
                  </div>
                  {!isProject && workspace.path === ws.path
                    ? <Check className="ml-auto shrink-0" />
                    : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </ScrollArea>
        </>
      ) : null}
    </>
  )

  if (!hasOnlineConnector) {
    return (
      <div className="flex w-fit max-w-full flex-col">
        <div className="flex w-full flex-wrap items-center gap-3 px-1 py-2 text-sm">
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t("noOnlineDeviceTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("noOnlineDeviceDescription")}</p>
          </div>
          <Button size="sm" variant="outline" disabled={disabled} onClick={openPairDeviceDialog}>
            <Plus className="size-4" />
            {t("addDevice")}
          </Button>
        </div>
        <Separator />
      </div>
    )
  }

  return (
    <>
      <DropdownMenu>
        <div className="flex w-fit max-w-full flex-col">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="flex w-full min-w-0 items-center gap-2 px-1 py-2 text-left text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {isProject
                ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                : <Folder className="size-4 shrink-0 text-muted-foreground" />}
              <span className="max-w-[45%] shrink-0 truncate font-medium">
                {workspace.path ? selectedProject?.name ?? workspace.label : t("choosePath")}
              </span>
              {(selectedProject?.workspacePath ?? workspace.path) ? (
                <span className="min-w-0 truncate code-mono text-xs text-muted-foreground">
                  {selectedProject?.workspacePath ?? workspace.path}
                </span>
              ) : null}
              {!workspace.path && resolvingDefaultPath ? <Spinner className="size-3.5 shrink-0 text-muted-foreground" /> : null}
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <Separator />
        </div>

        <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
          {includeProjects ? (
            <>
              {!defaultWorkspace.projectId ? (
                <>
                  <DropdownMenuGroup>
                    <DropdownMenuItem disabled={!defaultWorkspace.path} onSelect={() => updateWorkspace(defaultWorkspace)}>
                      <Folder />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span>{t("default")}</span>
                        <span className="truncate code-mono text-xs text-muted-foreground">{defaultWorkspace.path || (resolvingDefaultPath ? t("loading") : "")}</span>
                      </span>
                      {isDefault ? <Check /> : null}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuLabel>{t("projects")}</DropdownMenuLabel>
              <ScrollArea className="max-h-56" viewportProps={{ className: "max-h-56" }}>
                <DropdownMenuGroup className="pr-1">
                  {availableProjects.length > 0 ? availableProjects.map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      className="items-start gap-2.5 py-2"
                      onPointerEnter={() => setHoveredProjectId(project.id)}
                      onPointerLeave={() => setHoveredProjectId(null)}
                      onSelect={() => updateWorkspace({
                        label: project.name,
                        path: project.workspacePath,
                        connectorId: project.connectorId,
                        projectId: project.id,
                      })}
                    >
                      <FolderOpen />
                      <span className="min-w-0 flex-1 overflow-hidden">
                        <span className="block truncate font-medium">{project.name}</span>
                        <OverflowMarquee
                          text={project.workspacePath}
                          active={hoveredProjectId === project.id}
                          className="block code-mono text-xs text-muted-foreground"
                        />
                      </span>
                      {selectedProject?.id === project.id ? <Check className="ml-auto" /> : null}
                    </DropdownMenuItem>
                  )) : (
                    <DropdownMenuItem disabled className="justify-center py-6 text-muted-foreground">
                      {t("noProjects")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              </ScrollArea>

              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className="gap-2.5"
                  disabled={!onCreateProject}
                  onSelect={() => onCreateProject?.()}
                >
                  <Plus />
                  <span>{t("newProject")}</span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          ) : workspaceMenuGroups}
        </DropdownMenuContent>
      </DropdownMenu>

      {!includeProjects ? <FileBrowserDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        connectorId={activeConnector?.id ?? ""}
        connectorDeviceOs={activeConnector?.deviceOs}
        token={authSession?.accessToken}
        initialPath={workspace.path || defaultWorkspace.path || "~"}
        onConfirm={(path) => {
          const label = workspaceName(path)
          updateWorkspace({ label, path, connectorId: activeConnectorId })
        }}
      /> : null}
    </>
  )
}
