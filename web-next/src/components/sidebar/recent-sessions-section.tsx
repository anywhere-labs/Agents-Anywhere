"use client"

import * as React from "react"
import { SessionFilterMenu } from "@/components/session-filter-menu"
import { SessionPageTrigger } from "@/components/sidebar/session-page-trigger"
import { SessionSidebarItem } from "@/components/sidebar/session-sidebar-item"
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
import type { WorkspaceSessionView } from "@/components/workspace-context"
import { useTranslations } from "next-intl"

type RecentSessionsSectionProps = {
  sessions: WorkspaceSessionView[]
  label?: string
  isLoading: boolean
  hasMoreSessions: boolean
  isLoadingMoreSessions: boolean
  activeSessionId: string | null
  onMarkAllRead: () => void | Promise<void>
  onOpenSession: (sessionId: string) => void
  onToggleSessionPin: (sessionId: string) => void
  onToggleSessionArchive: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => Promise<boolean>
  onLoadMoreSessions: () => void
}

export function RecentSessionsSection({
  sessions,
  label,
  isLoading,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessionId,
  onMarkAllRead,
  onOpenSession,
  onToggleSessionPin,
  onToggleSessionArchive,
  onRenameSession,
  onLoadMoreSessions,
}: RecentSessionsSectionProps) {
  const t = useTranslations("dashboard")
  const [expanded, setExpanded] = React.useState(true)

  return (
    <SidebarGroup>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <SidebarGroupLabel
          className="group/recent flex items-center justify-between pr-1"
          role="heading"
          aria-level={2}
        >
          <SidebarSectionTrigger label={label ?? t("sections.recents")} expanded={expanded} />
          <SessionFilterMenu onMarkAllRead={onMarkAllRead} />
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <SidebarLoadingItem label={t("status.loadingSessions")} />
              ) : sessions.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">{t("empty.noSessionsMatch")}</p>
              ) : (
                sessions.map((item) => (
                  <SessionSidebarItem
                    key={item.id}
                    item={item}
                    isActive={activeSessionId === item.id}
                    onOpen={() => onOpenSession(item.id)}
                    onTogglePin={() => onToggleSessionPin(item.id)}
                    onToggleArchive={() => onToggleSessionArchive(item.id)}
                    onRename={(title) => onRenameSession(item.id, title)}
                  />
                ))
              )}
              {!isLoading && hasMoreSessions ? (
                <SessionPageTrigger
                  loading={isLoadingMoreSessions}
                  label={t("status.loadingSessions")}
                  onVisible={onLoadMoreSessions}
                />
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  )
}
