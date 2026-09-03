"use client"

import * as React from "react"
import {
  Archive,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  SquarePen,
  Trash2,
} from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { WorkspaceSessionView } from "@/components/workspace-context"
import { SessionSidebarItem } from "@/components/sidebar/session-sidebar-item"
import { SidebarLoadingItem } from "@/components/sidebar/sidebar-loading-item"
import { OverflowMarquee } from "@/components/sidebar/overflow-marquee"
import type { ProjectView } from "@/features/dashboard/types"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

export function ProjectSidebarItem({
  project,
  sessions,
  expanded,
  loading,
  activeSessionId,
  onExpandedChange,
  onOpenSession,
  onNewSession,
  onEdit,
  onTogglePin,
  onArchiveAll,
  onRemove,
  onToggleSessionPin,
  onToggleSessionArchive,
  onRenameSession,
}: {
  project: ProjectView
  sessions: WorkspaceSessionView[]
  expanded: boolean
  loading: boolean
  activeSessionId: string | null
  onExpandedChange: (open: boolean) => void
  onOpenSession: (sessionId: string) => void
  onNewSession: () => void
  onEdit: () => void
  onTogglePin: () => void
  onArchiveAll: () => void
  onRemove: () => void
  onToggleSessionPin: (sessionId: string) => void
  onToggleSessionArchive: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => Promise<boolean>
}) {
  const t = useTranslations("dashboard")
  const [nameHovered, setNameHovered] = React.useState(false)
  const visibleSessions = sessions.filter((session) => !session.archived)
  const containsActiveSession = visibleSessions.some((session) => session.id === activeSessionId)

  return (
    <SidebarMenuItem>
      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <div
          className="group/project relative"
          onPointerEnter={() => setNameHovered(true)}
          onPointerLeave={() => setNameHovered(false)}
        >
          <CollapsibleTrigger asChild>
            <SidebarMenuButton
              isActive={containsActiveSession}
              className="pr-[4.75rem] text-muted-foreground data-[active=true]:text-foreground"
            >
              {expanded ? <FolderOpen /> : <Folder />}
              <OverflowMarquee text={project.name} active={nameHovered} />
            </SidebarMenuButton>
          </CollapsibleTrigger>

          <TooltipProvider delayDuration={300}>
            <div
              className={cn(
                "absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5",
                "group-hover/project:flex group-focus-within/project:flex",
                containsActiveSession && "flex",
              )}
            >
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("projects.options")}
                      onClick={(event) => event.stopPropagation()}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent/65 hover:text-foreground"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>{t("projects.options")}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={onEdit}>
                    <Pencil />
                    {t("projects.edit")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onTogglePin}>
                    <Pin />
                    {project.pinned ? t("projects.unpin") : t("projects.pin")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onArchiveAll}>
                    <Archive />
                    {t("projects.archiveAll")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                    <Trash2 />
                    {t("projects.remove")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("projects.newSession")}
                  onClick={(event) => {
                    event.stopPropagation()
                    onNewSession()
                  }}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent/65 hover:text-foreground"
                >
                  <SquarePen className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>{t("projects.newSession")}</TooltipContent>
            </Tooltip>
            </div>
          </TooltipProvider>
        </div>

        <CollapsibleContent>
          <SidebarMenu className="ml-4 w-[calc(100%-1rem)] pl-2">
            {loading ? (
              <SidebarLoadingItem label={t("status.loadingSessions")} />
            ) : visibleSessions.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">{t("projects.noSessions")}</li>
            ) : (
              visibleSessions.map((session) => (
                <SessionSidebarItem
                  key={session.id}
                  item={session}
                  isActive={activeSessionId === session.id}
                  onOpen={() => onOpenSession(session.id)}
                  onTogglePin={() => onToggleSessionPin(session.id)}
                  onToggleArchive={() => onToggleSessionArchive(session.id)}
                  onRename={(title) => onRenameSession(session.id, title)}
                />
              ))
            )}
          </SidebarMenu>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  )
}
