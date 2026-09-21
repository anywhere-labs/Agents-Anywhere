"use client"

import * as React from "react"
import { Plus, Smartphone } from "lucide-react"
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
  filterProjectSessions,
  resolveProjectIdentity,
  sessionIdentityLabel,
} from "@/components/sidebar/project-identity"
import {
  selectPinnedProjects,
  selectPinnedSessions,
  selectAllSessions,
  groupSessionsByProject,
  selectProjectSessions,
  selectRegularProjects,
  type ProjectSessionStatusFilter,
} from "@/components/sidebar/sidebar-selectors"
import { SidebarAccountFooter } from "@/components/sidebar/sidebar-account-footer"
import { useProjectSidebarPreferences } from "@/components/sidebar/use-project-sidebar-preferences"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useWorkspace, type WorkspaceSessionView } from "@/components/workspace-context"
import { dashboardApi } from "@/features/dashboard/api"
import { defaultFilter } from "@/lib/demo-api"
import type { ProjectView } from "@/features/dashboard/types"
import { useMobileConnectionsSidebarVisibility } from "@/features/mobile-connections/sidebar-visibility"
import { useTranslations } from "next-intl"

export function AppSidebar({ contained = false }: { contained?: boolean }) {
  const {
    connectors,
    sessions,
    projects,
    isLoading,
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
    sidebarShowsSessions,
    setFilter,
    createProject,
    updateProject,
    archiveProjectSessions,
    togglePinSession,
    toggleArchiveSession,
    renameSession,
    refreshData,
  } = useWorkspace()
  const { signOut, me, session: authSession } = useAuth()
  const [mobileConnectionsSidebarVisible] = useMobileConnectionsSidebarVisibility()
  const t = useTranslations("dashboard")
  const [pairOpen, setPairOpen] = React.useState(false)
  const { preferences: { projectsExpanded, expandedProjectIds }, setProjectExpanded, setProjectsExpanded } =
    useProjectSidebarPreferences(authSession?.userId ?? "signed-out")
  const [projectEditor, setProjectEditor] = React.useState<ProjectEditorState>(null)
  const [projectToArchive, setProjectToArchive] = React.useState<ProjectView | null>(null)
  const [projectSessionStatus, setProjectSessionStatus] =
    React.useState<ProjectSessionStatusFilter>("active")

  const pinnedProjects = React.useMemo(
    () => selectPinnedProjects(projects, sessions, projectSessionStatus, filter),
    [filter, projectSessionStatus, projects, sessions],
  )
  const pinnedSessions = React.useMemo(
    () => selectPinnedSessions(sessions),
    [sessions],
  )
  const regularProjects = React.useMemo(
    () => selectRegularProjects(projects, sessions, projectSessionStatus, filter),
    [filter, projectSessionStatus, projects, sessions],
  )
  // Same list without the device/Agent gate, used to explain an empty section.
  const projectsWithoutDeviceAgentFilter = React.useMemo(
    () => selectRegularProjects(projects, sessions, projectSessionStatus, defaultFilter),
    [projectSessionStatus, projects, sessions],
  )
  const allSessions = React.useMemo(
    () => selectAllSessions(sessions, filter, search),
    [filter, search, sessions],
  )
  const projectSessionsById = React.useMemo(
    () => groupSessionsByProject(sessions),
    [sessions],
  )
  const unassignedSessions = React.useMemo(() => {
    const projectIds = new Set(projects.map((project) => project.id))
    return allSessions.filter((session) => !session.projectId || !projectIds.has(session.projectId))
  }, [allSessions, projects])
  const hiddenByDeviceAgentFilter = !isLoading
    && regularProjects.length === 0
    && projectsWithoutDeviceAgentFilter.length > 0

  // A row only shows the dimension that is actually filtered: with "all
  // devices" the device name stays off, with "all Agents" the Agent stays off,
  // and with both on "all" the row keeps its original single line.
  const identityParts = React.useMemo(() => ({
    includeDevice: filter.connectorId !== "all",
    includeAgents: filter.runtime !== "all",
  }), [filter.connectorId, filter.runtime])

  const sessionsForProject = React.useCallback(
    (projectId: string, status: ProjectSessionStatusFilter = "active") => selectProjectSessions(
      projectSessionsById[projectId] ?? [],
      status,
      filter,
    ),
    [filter, projectSessionsById],
  )

  const identityForProject = React.useCallback(
    // Identity follows the active device/Agent filter, so the label never
    // contradicts the sessions the row would actually expand into.
    (project: ProjectView) => resolveProjectIdentity(
      project,
      filterProjectSessions(projectSessionsById[project.id] ?? [], filter),
      connectors,
    ),
    [connectors, filter, projectSessionsById],
  )

  const sessionMeta = React.useCallback(
    (session: WorkspaceSessionView) => sessionIdentityLabel(session, connectors, identityParts),
    [connectors, identityParts],
  )

  const clearDeviceAgentFilter = React.useCallback(() => setFilter(defaultFilter), [setFilter])

  const markAllRead = React.useCallback(async () => {
    if (!authSession?.accessToken) return
    const unreadIds = sessions.filter((session) => session.unread).map((session) => session.id)
    if (unreadIds.length === 0) return
    await dashboardApi.bulkMarkSessionsRead(authSession.accessToken, unreadIds)
    refreshData()
  }, [authSession?.accessToken, refreshData, sessions])

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
    identityForProject,
    identityParts,
    expandedProjectIds,
    activeSessionId,
    onExpandedChange: setProjectExpanded,
    onOpenSession: openSession,
    onNewSession: startProjectSession,
    onEdit: (project) => setProjectEditor({ mode: "edit", project }),
    onTogglePin: (project) => void toggleProjectPin(project),
    onArchiveAll: setProjectToArchive,
    onToggleSessionPin: togglePinSession,
    onToggleSessionArchive: requestToggleSessionArchive,
    onRenameSession: renameSession,
  }

  return (
    <Sidebar contained={contained} className="border-sidebar-border">
      <SidebarHeader className="gap-0 px-4 pb-2 pt-4">
        <div className="flex min-h-7 items-center justify-between">
          <button type="button" onClick={goHome} className="aa-wordmark min-w-0 text-left text-xl">
            Agents Anywhere
          </button>
        </div>

        <SidebarMenu className="mt-3">
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-10 font-medium"
              isActive={page === "home"}
              onClick={goHome}
            >
              <Plus />
              <span>{t("actions.newSession")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {mobileConnectionsSidebarVisible ? (
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
          ) : null}
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-2">

        <DevicesSection
          connectors={connectors}
          isLoading={isLoading}
          page={page}
          activeConnectorId={activeConnectorId}
          onOpenDevice={navigateToDevice}
          onPairDevice={() => setPairOpen(true)}
        />

        <PinnedSection
          projects={sidebarShowsSessions ? [] : pinnedProjects}
          sessions={pinnedSessions}
          isLoading={isLoading}
          projectController={projectController}
          projectSessionStatus={projectSessionStatus}
          sessionMeta={sessionMeta}
          onOpenSession={openSession}
          onToggleSessionPin={togglePinSession}
          onToggleSessionArchive={requestToggleSessionArchive}
          onRenameSession={renameSession}
        />

        {sidebarShowsSessions ? (
          <RecentSessionsSection
            label={t("sections.sessions")}
            sessions={allSessions}
            isLoading={isLoading}
            activeSessionId={activeSessionId}
            sessionMeta={sessionMeta}
            onMarkAllRead={markAllRead}
            onOpenSession={openSession}
            onToggleSessionPin={togglePinSession}
            onToggleSessionArchive={requestToggleSessionArchive}
            onRenameSession={renameSession}
          />
        ) : (
          <>
            <ProjectsSection
              projects={regularProjects}
              isLoading={isLoading}
              expanded={projectsExpanded}
              controller={projectController}
              sessionStatus={projectSessionStatus}
              hiddenByDeviceAgentFilter={hiddenByDeviceAgentFilter}
              onClearDeviceAgentFilter={clearDeviceAgentFilter}
              onExpandedChange={setProjectsExpanded}
              onSessionStatusChange={setProjectSessionStatus}
              onAddProject={() => setProjectEditor({ mode: "create" })}
            />
            {unassignedSessions.length > 0 ? (
              <RecentSessionsSection
                label={t("sections.unassignedSessions")}
                sessions={unassignedSessions}
                isLoading={isLoading}
                activeSessionId={activeSessionId}
                sessionMeta={sessionMeta}
                onMarkAllRead={markAllRead}
                onOpenSession={openSession}
                onToggleSessionPin={togglePinSession}
                onToggleSessionArchive={requestToggleSessionArchive}
                onRenameSession={renameSession}
              />
            ) : null}
          </>
        )}
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
        projects={projects}
        onOpenChange={(open) => {
          if (!open) setProjectEditor(null)
        }}
        onCreate={createProject}
        onUpdate={updateProject}
      />

      <ProjectConfirmationDialogs
        projectToArchive={projectToArchive}
        onProjectToArchiveChange={setProjectToArchive}
        onArchiveProjectSessions={archiveProjectSessions}
      />
    </Sidebar>
  )
}
