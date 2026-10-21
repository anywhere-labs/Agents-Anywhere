"use client"

import * as React from "react"
import { CheckCheck } from "lucide-react"
import { SessionFilterMenu } from "@/components/session-filter-menu"
import { SessionSidebarItem } from "@/components/sidebar/session-sidebar-item"
import { SidebarLoadingItem } from "@/components/sidebar/sidebar-loading-item"
import { SidebarSectionTrigger } from "@/components/sidebar/sidebar-section-trigger"
import { capRecentSessions } from "@/components/sidebar/sidebar-session-cap"
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
  activeSessionId: string | null
  /** Optional `device · agent` identity line for each session row. */
  sessionMeta?: (session: WorkspaceSessionView) => string | null
  onMarkAllRead: () => void | Promise<void>
  onOpenSession: (sessionId: string) => void
  onToggleSessionPin: (sessionId: string) => void
  onToggleSessionArchive: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => Promise<boolean>
}

export function RecentSessionsSection({
  sessions,
  label,
  isLoading,
  activeSessionId,
  sessionMeta,
  onMarkAllRead,
  onOpenSession,
  onToggleSessionPin,
  onToggleSessionArchive,
  onRenameSession,
}: RecentSessionsSectionProps) {
  const t = useTranslations("dashboard")
  const [expanded, setExpanded] = React.useState(true)
  const [showAll, setShowAll] = React.useState(false)
  const { visible, hiddenCount } = React.useMemo(
    () => capRecentSessions(sessions, { expanded: showAll, activeSessionId }),
    [sessions, showAll, activeSessionId],
  )

  return (
    <SidebarGroup>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <SidebarGroupLabel
          className="flex items-center gap-1"
          role="heading"
          aria-level={2}
        >
          <SidebarSectionTrigger label={label ?? t("sections.recents")} expanded={expanded} />
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
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <SidebarLoadingItem label={t("status.loadingSessions")} />
              ) : sessions.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">{t("empty.noSessionsMatch")}</p>
              ) : (
                visible.map((item, index) => (
                  <SessionSidebarItem
                    key={item.id}
                    item={item}
                    previousConnectorId={visible[index - 1]?.connectorId}
                    meta={sessionMeta?.(item) ?? null}
                    isActive={activeSessionId === item.id}
                    onOpen={() => onOpenSession(item.id)}
                    onTogglePin={() => onToggleSessionPin(item.id)}
                    onToggleArchive={() => onToggleSessionArchive(item.id)}
                    onRename={(title) => onRenameSession(item.id, title)}
                  />
                ))
              )}
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="mx-2 rounded-md px-2 py-1.5 text-left text-xs text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                >
                  {t("actions.showMoreSessions", { count: hiddenCount })}
                </button>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  )
}
