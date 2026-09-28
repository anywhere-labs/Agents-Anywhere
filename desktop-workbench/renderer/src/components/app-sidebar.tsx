"use client"

import * as React from "react"
import { DesktopConnectionStatus } from "@/components/desktop/desktop-shell-header"
import { FolderPlus, Plus, Smartphone } from "lucide-react"
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
import { useWorkspace } from "@/components/workspace-context"
import { dashboardApi } from "@/features/dashboard/api"
import { useDesktopConnector } from "@/features/desktop/desktop-connector-context"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import { availableProjectName, findWorkspaceProject, workspaceName } from "@/features/dashboard/project-workspaces"
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
    setSidebarShowsSessions,
    createProject,
    updateProject,
    archiveProjectSessions,
    togglePinSession,
    toggleArchiveSession,
    renameSession,
    refreshData,
  } = useWorkspace()
  const { signOut, me, session: authSession } = useAuth()
  const { isLocalConnector, binding, state: localConnectorState } = useDesktopConnector()
  const [mobileConnectionsSidebarVisible] = useMobileConnectionsSidebarVisibility()
  const t = useTranslations("dashboard")
  const [pairOpen, setPairOpen] = React.useState(false)
  const { preferences: { projectsExpanded, expandedProjectIds }, setProjectExpanded, setProjectsExpanded } =
    useProjectSidebarPreferences(authSession?.userId ?? "signed-out")
  const [projectEditor, setProjectEditor] = React.useState<ProjectEditorState>(null)
  const [projectToArchive, setProjectToArchive] = React.useState<ProjectView | null>(null)
  const [folderDropActive, setFolderDropActive] = React.useState(false)
  const [projectSessionStatus, setProjectSessionStatus] =
    React.useState<ProjectSessionStatusFilter>("active")

  const pinnedProjects = React.useMemo(
    () => selectPinnedProjects(projects, sessions, projectSessionStatus),
    [projectSessionStatus, projects, sessions],
  )
  const pinnedSessions = React.useMemo(
    () => selectPinnedSessions(sessions),
    [sessions],
  )
  const regularProjects = React.useMemo(
    () => selectRegularProjects(projects, sessions, projectSessionStatus),
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

  const sessionsForProject = React.useCallback(
    (projectId: string, status: ProjectSessionStatusFilter = "active") => selectProjectSessions(
      projectSessionsById[projectId] ?? [],
      status,
    ),
    [projectSessionsById],
  )

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

  const handleFolderDrop = async (file: File | undefined) => {
    const folderBridge = getDesktopWorkbenchBridge()?.files
    if (!folderBridge) return
    try {
      const folder = file ? await folderBridge.droppedFolderPath(file) : null
      if (!folder) {
        toast.error(t("projects.folderRequired"))
        return
      }
      const localConnectorId = binding?.connectorId ?? localConnectorState?.connectorId
      const connector = connectors.find((item) => item.id === localConnectorId && item.status === "online")
      if (!connector) {
        toast.error(t("projects.localDeviceRequired"))
        return
      }
      const token = authSession?.accessToken
      if (!token) return
      const latestProjects = (await dashboardApi.listProjects(token)).projects
      const existing = findWorkspaceProject(latestProjects, connector.id, folder, connector.deviceOs)
      if (existing?.manuallyCreated) {
        toast.info(t("projects.folderAlreadyAdded"))
        return
      }
      const name = existing?.name ?? availableProjectName(workspaceName(folder), latestProjects)
      const created = await createProject({ name, connectorId: connector.id, workspacePath: folder, manuallyCreated: true })
      if (!created) throw new Error(t("projects.createFailed"))
      setSidebarShowsSessions(false)
      setProjectsExpanded(true)
      toast.success(t("projects.folderAdded"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("projects.createFailed"))
    }
  }

  const acceptsFolderDrop = (event: React.DragEvent) => Boolean(getDesktopWorkbenchBridge()?.files)
    && Array.from(event.dataTransfer.types).includes("Files")

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
    <Sidebar
      contained={contained}
      className="border-sidebar-border [&_[data-slot=sidebar-inner]]:relative"
      onDragOver={(event) => {
        if (!acceptsFolderDrop(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
        setFolderDropActive(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFolderDropActive(false)
      }}
      onDrop={(event) => {
        if (!acceptsFolderDrop(event)) return
        event.preventDefault()
        setFolderDropActive(false)
        void handleFolderDrop(event.dataTransfer.files[0])
      }}
    >
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
        <DesktopConnectionStatus />
      </SidebarHeader>

      <SidebarContent className="px-2">
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
          projects={sidebarShowsSessions ? [] : pinnedProjects}
          sessions={pinnedSessions}
          isLoading={isLoading}
          projectController={projectController}
          projectSessionStatus={projectSessionStatus}
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

      {folderDropActive ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-sidebar/90 px-4 text-center text-sidebar-foreground">
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-primary px-5 py-6">
            <FolderPlus className="size-7 text-primary" aria-hidden="true" />
            <span className="text-sm font-medium">{t("projects.dropFolder")}</span>
          </div>
        </div>
      ) : null}

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
