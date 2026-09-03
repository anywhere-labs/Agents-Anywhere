"use client"

import * as React from "react"
import {
  CheckCheck,
  ChevronDown,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Plus,
  Search,
  Server,
  Settings,
  Smartphone,
  SquarePen,
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
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useWorkspace } from "@/components/workspace-context"
import { SessionFilterMenu } from "@/components/session-filter-menu"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import type { ProjectView } from "@/features/dashboard/types"
import { PairDeviceDialog } from "@/components/pair-device-dialog"
import { DeviceSidebarItem } from "@/components/sidebar/device-sidebar-item"
import {
  ProjectEditorDialog,
  type ProjectEditorState,
} from "@/components/sidebar/project-editor-dialog"
import { ProjectSidebarItem } from "@/components/sidebar/project-sidebar-item"
import {
  selectPinnedProjects,
  selectPinnedSessions,
  selectProjectSessions,
  selectRecentSessions,
  selectRegularProjects,
} from "@/components/sidebar/sidebar-selectors"
import { SessionPageTrigger, SessionSidebarItem } from "@/components/sidebar/session-sidebar-item"
import { SidebarLoadingItem } from "@/components/sidebar/sidebar-loading-item"
import { useDesktopConnector } from "@/features/desktop/desktop-connector-context"
import { useTranslations } from "next-intl"

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
    activeConnectorId,
    page,
    filter,
    search,
    openSession,
    goHome,
    navigate,
    navigateToDevice,
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
  const { isLocalConnector } = useDesktopConnector()
  const t = useTranslations("dashboard")
  const tCommon = useTranslations("common")
  const [signOutOpen, setSignOutOpen] = React.useState(false)
  const [pairOpen, setPairOpen] = React.useState(false)
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
    () => selectPinnedProjects(projects),
    [projects],
  )
  const pinnedSessions = React.useMemo(
    () => selectPinnedSessions(sessions),
    [sessions],
  )
  const regularProjects = React.useMemo(
    () => selectRegularProjects(projects),
    [projects],
  )
  const sessionsById = React.useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  )

  const sessionsForProject = React.useCallback(
    (projectId: string) => selectProjectSessions(
      projectSessionsById[projectId] ?? [],
      sessionsById,
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
    () => selectRecentSessions(sessions, filter, search),
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
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-2">
        <SidebarGroup className="pb-0 pt-0">
          <SidebarGroupContent>
            <SidebarMenu>
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
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between pr-1" role="heading" aria-level={2}>
            <span>{t("sections.devices")}</span>
            <button
              type="button"
              aria-label={t("actions.pairDevice")}
              onClick={() => setPairOpen(true)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <SidebarLoadingItem label={t("status.loadingDevices")} />
              ) : connectors.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">{t("empty.noDevicesShort")}</p>
              ) : (
                connectors.map((connector) => (
                  <DeviceSidebarItem
                    key={connector.id}
                    connector={connector}
                    isLocal={isLocalConnector(connector.id)}
                    isActive={
                      (page === "device" || page === "device-workspace") &&
                      activeConnectorId === connector.id
                    }
                    onOpen={() => navigateToDevice(connector.id)}
                  />
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {!isLoading && (pinnedProjects.length > 0 || pinnedSessions.length > 0) ? (
          <SidebarGroup>
            <SidebarGroupLabel role="heading" aria-level={2}>{t("sections.pinned")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pinnedProjects.map((project) => (
                  <ProjectSidebarItem
                    key={`project-${project.id}`}
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
                {pinnedSessions.map((item) => (
                  <SessionSidebarItem
                    key={`session-${item.id}`}
                    item={item}
                    isActive={page === "session" && activeSessionId === item.id}
                    onOpen={() => openSession(item.id)}
                    onTogglePin={() => togglePinSession(item.id)}
                    onToggleArchive={() => toggleArchiveSession(item.id)}
                    onRename={(title) => renameSession(item.id, title)}
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

      <PairDeviceDialog
        open={pairOpen}
        onOpenChange={setPairOpen}
        onConnectorCreated={() => {
          refreshData()
        }}
      />

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
