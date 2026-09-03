"use client"

import { Plus } from "lucide-react"
import { ProjectSidebarItem } from "@/components/sidebar/project-sidebar-item"
import { SidebarLoadingItem } from "@/components/sidebar/sidebar-loading-item"
import { SidebarSectionTrigger } from "@/components/sidebar/sidebar-section-trigger"
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { WorkspaceSessionView } from "@/components/workspace-context"
import type { ProjectView } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

export type ProjectListController = {
  sessionsForProject: (projectId: string) => WorkspaceSessionView[]
  expandedProjectIds: string[]
  loadingProjectSessionIds: string[]
  activeSessionId: string | null
  onExpandedChange: (projectId: string, open: boolean) => void
  onOpenSession: (sessionId: string) => void
  onNewSession: (projectId: string) => void
  onEdit: (project: ProjectView) => void
  onTogglePin: (project: ProjectView) => void
  onArchiveAll: (project: ProjectView) => void
  onToggleSessionPin: (sessionId: string) => void
  onToggleSessionArchive: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => Promise<boolean>
}

export function ProjectList({
  projects,
  controller,
}: {
  projects: ProjectView[]
  controller: ProjectListController
}) {
  return (
    <>
      {projects.map((project) => (
        <ProjectSidebarItem
          key={project.id}
          project={project}
          sessions={controller.sessionsForProject(project.id)}
          expanded={controller.expandedProjectIds.includes(project.id)}
          loading={controller.loadingProjectSessionIds.includes(project.id)}
          activeSessionId={controller.activeSessionId}
          onExpandedChange={(open) => controller.onExpandedChange(project.id, open)}
          onOpenSession={controller.onOpenSession}
          onNewSession={() => controller.onNewSession(project.id)}
          onEdit={() => controller.onEdit(project)}
          onTogglePin={() => controller.onTogglePin(project)}
          onArchiveAll={() => controller.onArchiveAll(project)}
          onToggleSessionPin={controller.onToggleSessionPin}
          onToggleSessionArchive={controller.onToggleSessionArchive}
          onRenameSession={controller.onRenameSession}
        />
      ))}
    </>
  )
}

type ProjectsSectionProps = {
  projects: ProjectView[]
  isLoading: boolean
  expanded: boolean
  controller: ProjectListController
  onExpandedChange: (expanded: boolean) => void
  onAddProject: () => void
}

export function ProjectsSection({
  projects,
  isLoading,
  expanded,
  controller,
  onExpandedChange,
  onAddProject,
}: ProjectsSectionProps) {
  const t = useTranslations("dashboard")

  return (
    <SidebarGroup>
      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <SidebarGroupLabel className="flex items-center justify-between pr-1" role="heading" aria-level={2}>
          <SidebarSectionTrigger label={t("sections.projects")} expanded={expanded} />
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("projects.add")}
                  onClick={onAddProject}
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                >
                  <Plus className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{t("projects.add")}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <SidebarLoadingItem label={t("status.loadingProjects")} />
              ) : projects.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">{t("projects.empty")}</p>
              ) : (
                <ProjectList projects={projects} controller={controller} />
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  )
}
