"use client"

import { CheckCheck } from "lucide-react"
import { SessionFilterMenu } from "@/components/session-filter-menu"
import { SessionPageTrigger } from "@/components/sidebar/session-page-trigger"
import { SessionSidebarItem } from "@/components/sidebar/session-sidebar-item"
import { SidebarLoadingItem } from "@/components/sidebar/sidebar-loading-item"
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

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="flex items-center gap-1" role="heading" aria-level={2}>
        <span>{t("sections.recents")}</span>
        <SessionFilterMenu />
        <button
          type="button"
          aria-label={t("actions.markAllRead")}
          onClick={() => void onMarkAllRead()}
          className="rounded-md p-0.5 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <CheckCheck className="size-3.5" />
        </button>
      </SidebarGroupLabel>
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
    </SidebarGroup>
  )
}
