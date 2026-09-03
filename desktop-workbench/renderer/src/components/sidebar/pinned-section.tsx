"use client"

import { ProjectList, type ProjectListController } from "@/components/sidebar/projects-section"
import { SessionSidebarItem } from "@/components/sidebar/session-sidebar-item"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar"
import type { WorkspaceSessionView } from "@/components/workspace-context"
import type { ProjectView } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

type PinnedSectionProps = {
  projects: ProjectView[]
  sessions: WorkspaceSessionView[]
  isLoading: boolean
  projectController: ProjectListController
  onOpenSession: (sessionId: string) => void
  onToggleSessionPin: (sessionId: string) => void
  onToggleSessionArchive: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => Promise<boolean>
}

export function PinnedSection({
  projects,
  sessions,
  isLoading,
  projectController,
  onOpenSession,
  onToggleSessionPin,
  onToggleSessionArchive,
  onRenameSession,
}: PinnedSectionProps) {
  const t = useTranslations("dashboard")

  if (isLoading || (projects.length === 0 && sessions.length === 0)) return null

  return (
    <SidebarGroup>
      <SidebarGroupLabel role="heading" aria-level={2}>{t("sections.pinned")}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <ProjectList projects={projects} controller={projectController} />
          {sessions.map((item) => (
            <SessionSidebarItem
              key={`session-${item.id}`}
              item={item}
              isActive={projectController.activeSessionId === item.id}
              onOpen={() => onOpenSession(item.id)}
              onTogglePin={() => onToggleSessionPin(item.id)}
              onToggleArchive={() => onToggleSessionArchive(item.id)}
              onRename={(title) => onRenameSession(item.id, title)}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
