"use client"

import * as React from "react"
import {
  Archive,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Server,
  Settings,
  Smartphone,
  SquarePen,
  Trash2,
  Users,
} from "lucide-react"
import { toast } from "sonner"

import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import { filterSessions } from "@/lib/demo-api"
import {
  useWorkspace,
  type WorkspaceSessionView,
} from "@/components/workspace-context"
import { SessionFilterMenu } from "@/components/session-filter-menu"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import type {
  ProjectCreateRequest,
  ProjectPatchRequest,
  ProjectView,
} from "@/features/dashboard/types"
import {
  WorkspacePicker,
  type WorkspaceSelection,
} from "@/components/workspace-picker"
import { useTranslations } from "next-intl"

type ProjectEditorState =
  | { mode: "create" }
  | { mode: "edit"; project: ProjectView }
  | null

function timestamp(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function sortProjects(items: ProjectView[]): ProjectView[] {
  return [...items].sort((left, right) => {
    const pinnedDelta = timestamp(right.pinnedAt) - timestamp(left.pinnedAt)
    if (pinnedDelta !== 0) return pinnedDelta
    const activityDelta = timestamp(right.lastActivityAt) - timestamp(left.lastActivityAt)
    if (activityDelta !== 0) return activityDelta
    return left.name.localeCompare(right.name)
  })
}

function sortSidebarSessions(items: WorkspaceSessionView[]): WorkspaceSessionView[] {
  return [...items].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return timestamp(right.sortAt ?? right.updatedAt) - timestamp(left.sortAt ?? left.updatedAt)
  })
}

export function AppSidebar({ contained = false }: { contained?: boolean }) {
  const {
    connectors,
    sessions,
    projects,
    projectSessionsById,
    loadingProjectSessionIds,
    isLoading,
    hasMoreSessions,
    isLoadingMoreSessions,
    activeSessionId,
    page,
    filter,
    search,
    openSession,
    goHome,
    navigate,
    startProjectSession,
    loadProjectSessions,
    createProject,
    updateProject,
    removeProject,
    archiveProjectSessions,
    togglePinSession,
    toggleArchiveSession,
    renameSession,
    refreshData,
    loadMoreSessions,
  } = useWorkspace()
  const { signOut, me, session: authSession } = useAuth()
  const t = useTranslations("dashboard")
  const tCommon = useTranslations("common")
  const [signOutOpen, setSignOutOpen] = React.useState(false)
  const [projectsExpanded, setProjectsExpanded] = React.useState(true)
  const [expandedProjectIds, setExpandedProjectIds] = React.useState<string[]>([])
  const [projectEditor, setProjectEditor] = React.useState<ProjectEditorState>(null)
  const [projectToArchive, setProjectToArchive] = React.useState<ProjectView | null>(null)
  const [projectToRemove, setProjectToRemove] = React.useState<ProjectView | null>(null)

  const userId = me?.userId ?? "Unknown"
  const userRole = me?.role ? me.role.replace(/^\w/, (char) => char.toUpperCase()) : ""
  const userInitials = userId.slice(0, 2).toUpperCase()
  const isAdmin = me?.role === "admin"

  const pinnedProjects = React.useMemo(
    () => sortProjects(projects.filter((project) => project.pinned)),
    [projects],
  )
  const regularProjects = React.useMemo(
    () => sortProjects(projects.filter((project) => !project.pinned)),
    [projects],
  )
  const sessionsById = React.useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  )

  const sessionsForProject = React.useCallback(
    (projectId: string) => sortSidebarSessions(
      (projectSessionsById[projectId] ?? []).map(
        (session) => sessionsById.get(session.id) ?? session,
      ),
    ),
    [projectSessionsById, sessionsById],
  )

  const markAllRead = React.useCallback(async () => {
    if (!authSession?.accessToken) return
    const unreadIds = sessions.filter((s) => s.unread).map((s) => s.id)
    if (unreadIds.length === 0) return
    await dashboardApi.bulkMarkSessionsRead(authSession.accessToken, unreadIds)
    refreshData()
  }, [authSession?.accessToken, refreshData, sessions])


  const recentSessions = React.useMemo(
    () => sortSidebarSessions(
      filterSessions(
        sessions.filter((session) => !session.projectId),
        filter,
        search,
      ) as WorkspaceSessionView[],
    ),
    [filter, search, sessions],
  )

  const toggleProjectExpanded = React.useCallback((projectId: string, open: boolean) => {
    setExpandedProjectIds((current) => {
      if (open) return current.includes(projectId) ? current : [...current, projectId]
      return current.filter((id) => id !== projectId)
    })
    if (open) {
      void loadProjectSessions(projectId).then((loaded) => {
        if (loaded) return
        setExpandedProjectIds((current) => current.filter((id) => id !== projectId))
        toast.error(t("projects.loadSessionsFailed"))
      })
    }
  }, [loadProjectSessions, t])

  const toggleProjectPin = React.useCallback(async (project: ProjectView) => {
    const updated = await updateProject(project.id, { pinned: !project.pinned })
    if (!updated) toast.error(t("projects.updateFailed"))
  }, [t, updateProject])

  return (
    <Sidebar contained={contained} className="border-sidebar-border">
      <SidebarHeader className="gap-0 px-4 pb-2 pt-3">
        <div className="mb-3 mt-1 flex items-center justify-between gap-2">
          <button type="button" onClick={goHome} className="aa-wordmark min-w-0 pr-px text-left text-xl leading-none">
            Agents Anywhere
          </button>
          <button
            type="button"
            aria-label={t("actions.search")}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Search className="size-4" />
          </button>
        </div>

        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-10 font-medium"
              isActive={page === "home"}
              onClick={goHome}
            >
              <SquarePen />
              <span>{t("actions.newSession")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-10 font-medium"
              isActive={page === "mobile-connections"}
              onClick={() => navigate("mobile-connections")}
            >
              <Smartphone />
              <span>{t("actions.mobileConnections")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-2">
        {!isLoading && pinnedProjects.length > 0 ? (
          <SidebarGroup>
            <SidebarGroupLabel role="heading" aria-level={2}>{t("sections.pinned")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pinnedProjects.map((project) => (
                  <ProjectSidebarItem
                    key={project.id}
                    project={project}
                    sessions={sessionsForProject(project.id)}
                    expanded={expandedProjectIds.includes(project.id)}
                    loading={loadingProjectSessionIds.includes(project.id)}
                    activeSessionId={activeSessionId}
                    onExpandedChange={(open) => toggleProjectExpanded(project.id, open)}
                    onOpenSession={openSession}
                    onNewSession={() => startProjectSession(project.id)}
                    onEdit={() => setProjectEditor({ mode: "edit", project })}
                    onTogglePin={() => void toggleProjectPin(project)}
                    onArchiveAll={() => setProjectToArchive(project)}
                    onRemove={() => setProjectToRemove(project)}
                    onToggleSessionPin={togglePinSession}
                    onToggleSessionArchive={toggleArchiveSession}
                    onRenameSession={renameSession}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}

        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between pr-1" role="heading" aria-level={2}>
            <button
              type="button"
              className="flex min-w-0 items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              aria-expanded={projectsExpanded}
              onClick={() => setProjectsExpanded((value) => !value)}
            >
              <span>{t("sections.projects")}</span>
              {projectsExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("projects.add")}
                    onClick={() => setProjectEditor({ mode: "create" })}
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t("projects.add")}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </SidebarGroupLabel>
          {projectsExpanded ? (
            <SidebarGroupContent>
              <SidebarMenu>
                {isLoading ? (
                  <SidebarLoadingItem label={t("status.loadingProjects")} />
                ) : regularProjects.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">{t("projects.empty")}</p>
                ) : (
                  regularProjects.map((project) => (
                    <ProjectSidebarItem
                      key={project.id}
                      project={project}
                      sessions={sessionsForProject(project.id)}
                      expanded={expandedProjectIds.includes(project.id)}
                      loading={loadingProjectSessionIds.includes(project.id)}
                      activeSessionId={activeSessionId}
                      onExpandedChange={(open) => toggleProjectExpanded(project.id, open)}
                      onOpenSession={openSession}
                      onNewSession={() => startProjectSession(project.id)}
                      onEdit={() => setProjectEditor({ mode: "edit", project })}
                      onTogglePin={() => void toggleProjectPin(project)}
                      onArchiveAll={() => setProjectToArchive(project)}
                      onRemove={() => setProjectToRemove(project)}
                      onToggleSessionPin={togglePinSession}
                      onToggleSessionArchive={toggleArchiveSession}
                      onRenameSession={renameSession}
                    />
                  ))
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          ) : null}
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center gap-1" role="heading" aria-level={2}>
            <span>{t("sections.recents")}</span>
            <SessionFilterMenu />
            <button
              type="button"
              aria-label={t("actions.markAllRead")}
              onClick={() => void markAllRead()}
              className="rounded-md p-0.5 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <CheckCheck className="size-3.5" />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <SidebarLoadingItem label={t("status.loadingSessions")} />
              ) : recentSessions.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">{t("empty.noSessionsMatch")}</p>
              ) : (
                recentSessions.map((item) => (
                  <SessionSidebarItem
                    key={item.id}
                    item={item}
                    isActive={page === "session" && activeSessionId === item.id}
                    onOpen={() => openSession(item.id)}
                    onTogglePin={() => togglePinSession(item.id)}
                    onToggleArchive={() => toggleArchiveSession(item.id)}
                    onRename={(title) => renameSession(item.id, title)}
                  />
                ))
              )}
              {!isLoading && hasMoreSessions ? (
                <SessionPageTrigger
                  loading={isLoadingMoreSessions}
                  label={t("status.loadingSessions")}
                  onVisible={loadMoreSessions}
                />
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-3 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 transition-colors hover:bg-sidebar-accent"
            >
              <Avatar className="size-9 rounded-full">
                {me?.avatar && <AvatarImage src={me.avatar} alt={userId} />}
                <AvatarFallback className="rounded-full bg-primary text-primary-foreground">{userInitials}</AvatarFallback>
              </Avatar>
              <div className="flex flex-col leading-tight text-left">
                <span className="text-sm font-medium">{userId}</span>
                <span className="text-xs text-muted-foreground">{userRole}</span>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64 p-1">
            <div className="flex items-center gap-3 px-2 py-3">
              <Avatar className="size-12 rounded-full">
                {me?.avatar && <AvatarImage src={me.avatar} alt={userId} />}
                <AvatarFallback className="rounded-full bg-primary text-primary-foreground">{userInitials}</AvatarFallback>
              </Avatar>
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-semibold">{userId}</span>
                <span className="text-xs text-muted-foreground">{userRole}</span>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("settings", "account")}>
              <Settings className="size-4 text-muted-foreground" />
              {t("nav.settings")}
            </DropdownMenuItem>
            {isAdmin ? (
              <>
                <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("dashboard")}>
                  <LayoutDashboard className="size-4 text-muted-foreground" />
                  {t("nav.dashboard")}
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("team")}>
                  <Users className="size-4 text-muted-foreground" />
                  {t("nav.team")}
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("service")}>
                  <Server className="size-4 text-muted-foreground" />
                  {t("nav.service")}
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-3 py-2.5" onClick={() => setSignOutOpen(true)}>
              <LogOut className="size-4 text-muted-foreground" />
              {t("actions.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>

      <ProjectEditorDialog
        editor={projectEditor}
        connectors={connectors}
        onOpenChange={(open) => {
          if (!open) setProjectEditor(null)
        }}
        onCreate={createProject}
        onUpdate={updateProject}
      />

      <AlertDialog
        open={projectToArchive !== null}
        onOpenChange={(open) => {
          if (!open) setProjectToArchive(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("projects.archiveAllTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("projects.archiveAllDescription", { name: projectToArchive?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const project = projectToArchive
                setProjectToArchive(null)
                if (!project) return
                void archiveProjectSessions(project.id).then((ok) => {
                  if (ok) toast.success(t("projects.archiveAllSuccess"))
                  else toast.error(t("projects.archiveAllFailed"))
                })
              }}
            >
              {t("projects.archiveAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={projectToRemove !== null}
        onOpenChange={(open) => {
          if (!open) setProjectToRemove(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("projects.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("projects.removeDescription", { name: projectToRemove?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const project = projectToRemove
                setProjectToRemove(null)
                if (!project) return
                void removeProject(project.id).then((ok) => {
                  if (ok) toast.success(t("projects.removeSuccess"))
                  else toast.error(t("projects.removeFailed"))
                })
              }}
            >
              {t("projects.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={signOutOpen} onOpenChange={setSignOutOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("signOut.title")}</DialogTitle>
            <DialogDescription>
              {t("signOut.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setSignOutOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setSignOutOpen(false)
                signOut()
              }}
            >
              {t("actions.signOut")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  )
}

function ProjectSidebarItem({
  project,
  sessions,
  expanded,
  loading,
  activeSessionId,
  onExpandedChange,
  onOpenSession,
  onNewSession,
  onEdit,
  onTogglePin,
  onArchiveAll,
  onRemove,
  onToggleSessionPin,
  onToggleSessionArchive,
  onRenameSession,
}: {
  project: ProjectView
  sessions: WorkspaceSessionView[]
  expanded: boolean
  loading: boolean
  activeSessionId: string | null
  onExpandedChange: (open: boolean) => void
  onOpenSession: (sessionId: string) => void
  onNewSession: () => void
  onEdit: () => void
  onTogglePin: () => void
  onArchiveAll: () => void
  onRemove: () => void
  onToggleSessionPin: (sessionId: string) => void
  onToggleSessionArchive: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => Promise<boolean>
}) {
  const t = useTranslations("dashboard")
  const visibleSessions = sessions.filter((session) => !session.archived)
  const containsActiveSession = visibleSessions.some((session) => session.id === activeSessionId)

  return (
    <SidebarMenuItem>
      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <div className="group/project relative">
          <CollapsibleTrigger asChild>
            <SidebarMenuButton
              isActive={containsActiveSession}
              className="pr-[4.75rem] text-muted-foreground data-[active=true]:text-foreground"
            >
              {expanded ? <ChevronDown /> : <ChevronRight />}
              <Folder />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
            </SidebarMenuButton>
          </CollapsibleTrigger>

          <TooltipProvider delayDuration={300}>
            <div
              className={cn(
                "absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5",
                "group-hover/project:flex group-focus-within/project:flex",
                containsActiveSession && "flex",
              )}
            >
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("projects.options")}
                      onClick={(event) => event.stopPropagation()}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent/65 hover:text-foreground"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>{t("projects.options")}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={onEdit}>
                    <Pencil />
                    {t("projects.edit")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onTogglePin}>
                    <Pin />
                    {project.pinned ? t("projects.unpin") : t("projects.pin")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onArchiveAll}>
                    <Archive />
                    {t("projects.archiveAll")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                    <Trash2 />
                    {t("projects.remove")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("projects.newSession")}
                  onClick={(event) => {
                    event.stopPropagation()
                    onNewSession()
                  }}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent/65 hover:text-foreground"
                >
                  <SquarePen className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>{t("projects.newSession")}</TooltipContent>
            </Tooltip>
            </div>
          </TooltipProvider>
        </div>

        <CollapsibleContent>
          <SidebarMenu className="ml-4 w-[calc(100%-1rem)] border-l border-sidebar-border pl-2">
            {loading ? (
              <SidebarLoadingItem label={t("status.loadingSessions")} />
            ) : visibleSessions.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">{t("projects.noSessions")}</li>
            ) : (
              visibleSessions.map((session) => (
                <SessionSidebarItem
                  key={session.id}
                  item={session}
                  isActive={activeSessionId === session.id}
                  onOpen={() => onOpenSession(session.id)}
                  onTogglePin={() => onToggleSessionPin(session.id)}
                  onToggleArchive={() => onToggleSessionArchive(session.id)}
                  onRename={(title) => onRenameSession(session.id, title)}
                />
              ))
            )}
          </SidebarMenu>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  )
}

function ProjectEditorDialog({
  editor,
  connectors,
  onOpenChange,
  onCreate,
  onUpdate,
}: {
  editor: ProjectEditorState
  connectors: Array<{ id: string; name: string; status: string }>
  onOpenChange: (open: boolean) => void
  onCreate: (payload: ProjectCreateRequest) => Promise<ProjectView | null>
  onUpdate: (projectId: string, payload: ProjectPatchRequest) => Promise<ProjectView | null>
}) {
  const t = useTranslations("dashboard.projects")
  const tCommon = useTranslations("common")
  const [name, setName] = React.useState("")
  const [connectorId, setConnectorId] = React.useState("")
  const [workspace, setWorkspace] = React.useState<WorkspaceSelection | null>(null)
  const [saving, setSaving] = React.useState(false)
  const editingProject = editor?.mode === "edit" ? editor.project : null
  const onlineConnectors = connectors.filter((connector) => connector.status === "online")
  const selectedConnector = connectors.find((connector) => connector.id === connectorId)

  React.useEffect(() => {
    if (!editor) return
    if (editor.mode === "edit") {
      setName(editor.project.name)
      setConnectorId(editor.project.connectorId)
      setWorkspace({
        label: editor.project.name,
        path: editor.project.workspacePath,
        connectorId: editor.project.connectorId,
      })
    } else {
      setName("")
      setConnectorId(onlineConnectors[0]?.id ?? "")
      setWorkspace(null)
    }
    setSaving(false)
  }, [editor])

  const submit = React.useCallback(async () => {
    const projectName = name.trim()
    if (!editor || !projectName || saving) return
    setSaving(true)
    try {
      const result = editor.mode === "edit"
        ? await onUpdate(editor.project.id, { name: projectName })
        : workspace?.path && connectorId
          ? await onCreate({
              name: projectName,
              connectorId,
              workspacePath: workspace.path,
              attachMatchingSessions: true,
            })
          : null
      if (!result) {
        toast.error(t(editor.mode === "edit" ? "updateFailed" : "createFailed"))
        return
      }
      toast.success(t(editor.mode === "edit" ? "updateSuccess" : "createSuccess"))
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }, [connectorId, editor, name, onCreate, onOpenChange, onUpdate, saving, t, workspace?.path])

  return (
    <Dialog open={editor !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(editingProject ? "editTitle" : "createTitle")}</DialogTitle>
            <DialogDescription>
              {t(editingProject ? "editDescription" : "createDescription")}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">{t("name")}</FieldLabel>
              <Input
                id="project-name"
                autoFocus
                value={name}
                maxLength={255}
                disabled={saving}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder={t("namePlaceholder")}
              />
            </Field>

            {editingProject ? (
              <>
                <Field data-disabled>
                  <FieldLabel htmlFor="project-device">{t("device")}</FieldLabel>
                  <Input
                    id="project-device"
                    value={selectedConnector?.name ?? editingProject.connectorId}
                    disabled
                    readOnly
                  />
                </Field>
                <Field data-disabled>
                  <FieldLabel htmlFor="project-workspace">{t("workspace")}</FieldLabel>
                  <Input
                    id="project-workspace"
                    className="code-mono text-xs"
                    value={editingProject.workspacePath}
                    disabled
                    readOnly
                  />
                  <FieldDescription>{t("workspaceImmutable")}</FieldDescription>
                </Field>
              </>
            ) : (
              <>
                <Field data-disabled={onlineConnectors.length === 0 || undefined}>
                  <FieldLabel>{t("device")}</FieldLabel>
                  <Select
                    value={connectorId}
                    disabled={onlineConnectors.length === 0 || saving}
                    onValueChange={(value) => {
                      setConnectorId(value)
                      setWorkspace(null)
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t("selectDevice")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {onlineConnectors.map((connector) => (
                          <SelectItem key={connector.id} value={connector.id}>
                            {connector.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {onlineConnectors.length === 0 ? (
                    <FieldDescription>{t("onlineDeviceRequired")}</FieldDescription>
                  ) : null}
                </Field>
                <Field data-disabled={!connectorId || undefined}>
                  <FieldLabel>{t("workspace")}</FieldLabel>
                  {connectorId ? (
                    <WorkspacePicker
                      connectorId={connectorId}
                      value={workspace}
                      onChange={setWorkspace}
                    />
                  ) : (
                    <FieldDescription>{t("selectDeviceFirst")}</FieldDescription>
                  )}
                </Field>
              </>
            )}
          </FieldGroup>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={saving || name.trim().length === 0 || (!editingProject && (!connectorId || !workspace?.path))}
            >
              {saving ? <Spinner data-icon="inline-start" /> : null}
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SessionPageTrigger({
  loading,
  label,
  onVisible,
}: {
  loading: boolean
  label: string
  onVisible: () => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const onVisibleRef = React.useRef(onVisible)
  onVisibleRef.current = onVisible

  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !loading) onVisibleRef.current()
      },
      { rootMargin: "160px 0px" },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [loading])

  return (
    <div ref={ref} className="flex h-9 items-center justify-center" aria-label={label}>
      {loading ? <Spinner className="size-4 text-muted-foreground" /> : null}
    </div>
  )
}

function SessionSidebarItem({
  item,
  isActive,
  onOpen,
  onTogglePin,
  onToggleArchive,
  onRename,
}: {
  item: { id: string; title?: string | null; status: string; unread: boolean; pinned: boolean; archived: boolean }
  isActive: boolean
  onOpen: () => void
  onTogglePin: () => void
  onToggleArchive: () => void
  onRename: (title: string) => Promise<boolean>
}) {
  const t = useTranslations("dashboard")
  const tSession = useTranslations("dashboard.session")
  const tCommon = useTranslations("common")
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState(item.title ?? "")
  const [renaming, setRenaming] = React.useState(false)
  const isBusy = item.status === "running" || item.status === "waiting" || item.status === "pending"
  const isWaitingApproval = item.status === "waiting_approval"
  const isUnreadIdle = item.unread && item.status === "idle"
  const hasStatusIndicator = isBusy || isWaitingApproval || isUnreadIdle

  React.useEffect(() => {
    if (!renameOpen) setTitleDraft(item.title ?? "")
  }, [item.title, renameOpen])

  const cancelRename = React.useCallback(() => {
    setTitleDraft(item.title ?? "")
    setRenameOpen(false)
  }, [item.title])

  const submitRename = React.useCallback(async () => {
    const nextTitle = titleDraft.trim()
    if (!nextTitle) {
      cancelRename()
      return
    }
    if (renaming) return
    if (nextTitle === item.title) {
      setRenameOpen(false)
      return
    }
    setRenaming(true)
    try {
      const ok = await onRename(nextTitle)
      if (ok) setRenameOpen(false)
      else toast.error(tSession("renameFailed"))
    } finally {
      setRenaming(false)
    }
  }, [cancelRename, item.title, onRename, renaming, tSession, titleDraft])

  const copySessionId = async () => {
    try {
      await copyText(item.id)
      toast.success(t("actions.copiedSessionId"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("actions.copyFailed"))
    }
  }

  return (
    <>
      <ContextMenu>
        <SidebarMenuItem className="group/session">
          <ContextMenuTrigger asChild>
            <div>
              <SidebarMenuButton
                isActive={isActive}
                onClick={onOpen}
                className={cn(
                  "text-muted-foreground data-[active=true]:text-foreground",
                  !hasStatusIndicator && "group-hover/session:pr-[4.25rem] group-focus-within/session:pr-[4.25rem]",
                  isActive && !hasStatusIndicator && "pr-[4.25rem]",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <SessionSidebarIndicator
                  busy={isBusy}
                  unreadIdle={isUnreadIdle}
                  waitingApproval={isWaitingApproval}
                />
              </SidebarMenuButton>
            </div>
          </ContextMenuTrigger>

          {!hasStatusIndicator ? (
            <TooltipProvider delayDuration={300}>
              <div
                className={cn(
                  "absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5",
                  "group-hover/session:flex group-focus-within/session:flex",
                  isActive && "flex",
                )}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={item.pinned ? t("actions.unpinChat") : t("actions.pinChat")}
                      onClick={(e) => {
                        e.stopPropagation()
                        onTogglePin()
                      }}
                      className={cn(
                        "rounded p-1 transition-colors hover:bg-sidebar-accent/65 hover:text-foreground",
                        item.pinned ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      <Pin className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {item.pinned ? t("actions.unpinChat") : t("actions.pinChat")}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={item.archived ? t("actions.unarchiveChat") : t("actions.archiveChat")}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleArchive()
                      }}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent/65 hover:text-foreground"
                    >
                      <Archive className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {item.archived ? t("actions.unarchiveChat") : t("actions.archiveChat")}
                  </TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
          ) : null}
        </SidebarMenuItem>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={onOpen}>
            <FolderOpen className="size-4" />
            {t("actions.open")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil className="size-4" />
            {t("actions.rename")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onTogglePin}>
            <Pin className="size-4" />
            {item.pinned ? t("actions.unpin") : t("actions.pin")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onToggleArchive}>
            <Archive className="size-4" />
            {item.archived ? t("actions.unarchive") : t("actions.archive")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void copySessionId()}>
            <Copy className="size-4" />
            {t("actions.copySessionId")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={renameOpen} onOpenChange={(open: boolean) => {
        if (open) {
          setTitleDraft(item.title ?? "")
          setRenameOpen(true)
        } else {
          cancelRename()
        }
      }}>
        <DialogContent className="sm:max-w-sm">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submitRename()
            }}
          >
            <DialogHeader>
              <DialogTitle>{tSession("renameTitle")}</DialogTitle>
            </DialogHeader>
            <Input
              autoFocus
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === "Escape") {
                  event.preventDefault()
                  cancelRename()
                }
              }}
              disabled={renaming}
              aria-label={tSession("renameTitle")}
            />
            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" onClick={cancelRename} disabled={renaming}>
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={renaming || titleDraft.trim().length === 0}>
                {tCommon("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

function SessionSidebarIndicator({
  busy,
  unreadIdle,
  waitingApproval,
}: {
  busy: boolean
  unreadIdle: boolean
  waitingApproval: boolean
}) {
  const t = useTranslations("dashboard")

  if (waitingApproval) {
    return (
      <span className="ml-2 shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium leading-4 text-emerald-400 ring-1 ring-emerald-500/20">
        {t("sessionStatus.waitingApproval")}
      </span>
    )
  }
  if (busy) {
    return (
      <span
        aria-label={t("sessionStatus.running")}
        className="ml-2 size-3.5 shrink-0 animate-spin rounded-full border-2 border-sidebar-foreground/25 border-t-sidebar-foreground/75"
      />
    )
  }
  if (unreadIdle) {
    return (
      <span
        aria-label={t("sessionStatus.unread")}
        className="ml-2 size-2 shrink-0 rounded-full bg-emerald-500"
      />
    )
  }
  return null
}

function SidebarLoadingItem({ label }: { label: string }) {
  return (
    <SidebarMenuItem>
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        <span>{label}</span>
      </div>
    </SidebarMenuItem>
  )
}
