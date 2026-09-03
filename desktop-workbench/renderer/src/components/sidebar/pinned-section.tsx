"use client"

import * as React from "react"
import { ProjectList, type ProjectListController } from "@/components/sidebar/projects-section"
import { SessionSidebarItem } from "@/components/sidebar/session-sidebar-item"
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
  const [expanded, setExpanded] = React.useState(true)

  if (isLoading || (projects.length === 0 && sessions.length === 0)) return null

  return (
    <SidebarGroup>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <SidebarGroupLabel role="heading" aria-level={2}>
          <SidebarSectionTrigger label={t("sections.pinned")} expanded={expanded} />
        </SidebarGroupLabel>
        <CollapsibleContent>
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
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  )
}
