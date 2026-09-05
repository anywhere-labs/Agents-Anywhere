"use client"

import { MoreHorizontal, Plus } from "lucide-react"
import * as React from "react"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { WorkspaceSessionView } from "@/components/workspace-context"
import type { ProjectSessionStatusFilter } from "@/components/sidebar/sidebar-selectors"
import type { ProjectView } from "@/features/dashboard/types"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

export type ProjectListController = {
  sessionsForProject: (
    projectId: string,
    status?: ProjectSessionStatusFilter,
  ) => WorkspaceSessionView[]
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
  sessionStatus = "active",
}: {
  projects: ProjectView[]
  controller: ProjectListController
  sessionStatus?: ProjectSessionStatusFilter
}) {
  return (
    <>
      {projects.map((project) => (
        <ProjectSidebarItem
          key={project.id}
          project={project}
          sessions={controller.sessionsForProject(project.id, sessionStatus)}
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
  sessionStatus: ProjectSessionStatusFilter
  onExpandedChange: (expanded: boolean) => void
  onSessionStatusChange: (status: ProjectSessionStatusFilter) => void
  onAddProject: () => void
}

export function ProjectsSection({
  projects,
  isLoading,
  expanded,
  controller,
  sessionStatus,
  onExpandedChange,
  onSessionStatusChange,
  onAddProject,
}: ProjectsSectionProps) {
  const t = useTranslations("dashboard")
  const [filterOpen, setFilterOpen] = React.useState(false)

  return (
    <SidebarGroup>
      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <SidebarGroupLabel
          className="group/projects-label flex items-center justify-between pr-1"
          role="heading"
          aria-level={2}
        >
          <SidebarSectionTrigger label={t("sections.projects")} expanded={expanded} />
          <div className="flex items-center gap-0.5">
            <DropdownMenu open={filterOpen} onOpenChange={setFilterOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("projects.filterSessions")}
                  className={cn(
                    "rounded p-0.5 text-muted-foreground opacity-0 transition-[color,background-color,opacity]",
                    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    "group-hover/projects-label:opacity-100",
                    filterOpen && "bg-sidebar-accent text-sidebar-accent-foreground opacity-100",
                  )}
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right" className="w-56">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {t("projects.sessionStatus")}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={sessionStatus}
                  onValueChange={(value) => {
                    if (value === "active" || value === "archived" || value === "all") {
                      onSessionStatusChange(value)
                    }
                  }}
                >
                  <DropdownMenuRadioItem value="active">
                    <span className="truncate">{t("projects.statusActive")}</span>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="archived">
                    <span className="truncate">{t("projects.statusArchived")}</span>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="all">
                    <span className="truncate">{t("projects.statusAll")}</span>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

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
          </div>
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <SidebarLoadingItem label={t("status.loadingProjects")} />
              ) : projects.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">{t("projects.empty")}</p>
              ) : (
                <ProjectList
                  projects={projects}
                  controller={controller}
                  sessionStatus={sessionStatus}
                />
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  )
}
