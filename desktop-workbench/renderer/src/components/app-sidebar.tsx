"use client"

import * as React from "react"
import { Smartphone, SquarePen } from "lucide-react"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-context"
import { PairDeviceDialog } from "@/components/pair-device-dialog"
import { DevicesSection } from "@/components/sidebar/devices-section"
import { ProjectConfirmationDialogs } from "@/components/sidebar/project-confirmation-dialogs"
import {
  ProjectEditorDialog,
  type ProjectEditorState,
} from "@/components/sidebar/project-editor-dialog"
import {
  ProjectsSection,
  type ProjectListController,
} from "@/components/sidebar/projects-section"
import { PinnedSection } from "@/components/sidebar/pinned-section"
import { RecentSessionsSection } from "@/components/sidebar/recent-sessions-section"
import {
  selectPinnedProjects,
  selectPinnedSessions,
  selectProjectSessions,
  selectRecentSessions,
  selectRegularProjects,
} from "@/components/sidebar/sidebar-selectors"
import { SidebarAccountFooter } from "@/components/sidebar/sidebar-account-footer"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useWorkspace } from "@/components/workspace-context"
import { dashboardApi } from "@/features/dashboard/api"
import { useDesktopConnector } from "@/features/desktop/desktop-connector-context"
import type { ProjectView } from "@/features/dashboard/types"
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
  const [pairOpen, setPairOpen] = React.useState(false)
  const [projectsExpanded, setProjectsExpanded] = React.useState(true)
  const [expandedProjectIds, setExpandedProjectIds] = React.useState<string[]>([])
  const [projectEditor, setProjectEditor] = React.useState<ProjectEditorState>(null)
  const [projectToArchive, setProjectToArchive] = React.useState<ProjectView | null>(null)
  const [projectToRemove, setProjectToRemove] = React.useState<ProjectView | null>(null)

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
  const recentSessions = React.useMemo(
    () => selectRecentSessions(sessions, filter, search),
    [filter, search, sessions],
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
    const unreadIds = sessions.filter((session) => session.unread).map((session) => session.id)
    if (unreadIds.length === 0) return
    await dashboardApi.bulkMarkSessionsRead(authSession.accessToken, unreadIds)
    refreshData()
  }, [authSession?.accessToken, refreshData, sessions])

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

  const showSessionUnarchivedToast = React.useCallback((sessionId: string) => {
    toast.success(t("actions.unarchiveSuccess"), {
      action: {
        label: t("actions.viewNow"),
        onClick: () => openSession(sessionId),
      },
    })
  }, [openSession, t])

  const restoreArchivedSession = React.useCallback(async (sessionId: string) => {
    try {
      const updated = await toggleArchiveSession(sessionId, false)
      if (updated && !updated.archived) showSessionUnarchivedToast(sessionId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("actions.archiveUpdateFailed"))
    }
  }, [showSessionUnarchivedToast, t, toggleArchiveSession])

  const handleToggleSessionArchive = React.useCallback(async (sessionId: string) => {
    try {
      const updated = await toggleArchiveSession(sessionId)
      if (!updated) return
      if (!updated.archived) {
        showSessionUnarchivedToast(sessionId)
        return
      }
      toast.success(t("actions.archiveSuccess"), {
        action: {
          label: t("actions.unarchive"),
          onClick: () => void restoreArchivedSession(sessionId),
        },
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("actions.archiveUpdateFailed"))
    }
  }, [restoreArchivedSession, showSessionUnarchivedToast, t, toggleArchiveSession])

  const requestToggleSessionArchive = React.useCallback((sessionId: string) => {
    void handleToggleSessionArchive(sessionId)
  }, [handleToggleSessionArchive])

  const projectController: ProjectListController = {
    sessionsForProject,
    expandedProjectIds,
    loadingProjectSessionIds,
    activeSessionId,
    onExpandedChange: toggleProjectExpanded,
    onOpenSession: openSession,
    onNewSession: startProjectSession,
    onEdit: (project) => setProjectEditor({ mode: "edit", project }),
    onTogglePin: (project) => void toggleProjectPin(project),
    onArchiveAll: setProjectToArchive,
    onRemove: setProjectToRemove,
    onToggleSessionPin: togglePinSession,
    onToggleSessionArchive: requestToggleSessionArchive,
    onRenameSession: renameSession,
  }

  return (
    <Sidebar contained={contained} className="border-sidebar-border">
      <SidebarHeader className="gap-0 px-4 pb-2 pt-3">
        <div className="mb-3 mt-1 flex items-center">
          <button type="button" onClick={goHome} className="aa-wordmark min-w-0 pr-px text-left text-xl leading-none">
            Agents Anywhere
          </button>
        </div>

        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-9 font-medium"
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
                  className="h-9 font-medium"
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

        <DevicesSection
          connectors={connectors}
          isLoading={isLoading}
          page={page}
          activeConnectorId={activeConnectorId}
          isLocalConnector={isLocalConnector}
          onOpenDevice={navigateToDevice}
          onPairDevice={() => setPairOpen(true)}
        />

        <PinnedSection
          projects={pinnedProjects}
          sessions={pinnedSessions}
          isLoading={isLoading}
          projectController={projectController}
          onOpenSession={openSession}
          onToggleSessionPin={togglePinSession}
          onToggleSessionArchive={requestToggleSessionArchive}
          onRenameSession={renameSession}
        />

        <ProjectsSection
          projects={regularProjects}
          isLoading={isLoading}
          expanded={projectsExpanded}
          controller={projectController}
          onExpandedChange={setProjectsExpanded}
          onAddProject={() => setProjectEditor({ mode: "create" })}
        />

        <RecentSessionsSection
          sessions={recentSessions}
          isLoading={isLoading}
          hasMoreSessions={hasMoreSessions}
          isLoadingMoreSessions={isLoadingMoreSessions}
          activeSessionId={activeSessionId}
          onMarkAllRead={markAllRead}
          onOpenSession={openSession}
          onToggleSessionPin={togglePinSession}
          onToggleSessionArchive={requestToggleSessionArchive}
          onRenameSession={renameSession}
          onLoadMoreSessions={loadMoreSessions}
        />
      </SidebarContent>

      <SidebarAccountFooter me={me} navigate={navigate} signOut={signOut} />

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

      <ProjectConfirmationDialogs
        projectToArchive={projectToArchive}
        projectToRemove={projectToRemove}
        onProjectToArchiveChange={setProjectToArchive}
        onProjectToRemoveChange={setProjectToRemove}
        onArchiveProjectSessions={archiveProjectSessions}
        onRemoveProject={removeProject}
      />
    </Sidebar>
  )
}
