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
import { OverflowMarquee } from "@/components/sidebar/overflow-marquee"
import {
  projectIdentityLabel,
  type IdentityParts,
  type ProjectIdentity,
} from "@/components/sidebar/project-identity"
import type { ProjectView } from "@/features/dashboard/types"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

export function ProjectSidebarItem({
  project,
  sessions,
  identity,
  identityParts,
  expanded,
  activeSessionId,
  onExpandedChange,
  onOpenSession,
  onNewSession,
  onEdit,
  onTogglePin,
  onArchiveAll,
  onToggleSessionPin,
  onToggleSessionArchive,
  onRenameSession,
}: {
  project: ProjectView
  sessions: WorkspaceSessionView[]
  identity: ProjectIdentity
  identityParts: IdentityParts
  expanded: boolean
  activeSessionId: string | null
  onExpandedChange: (open: boolean) => void
  onOpenSession: (sessionId: string) => void
  onNewSession: () => void
  onEdit: () => void
  onTogglePin: () => void
  onArchiveAll: () => void
  onToggleSessionPin: (sessionId: string) => void
  onToggleSessionArchive: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => Promise<boolean>
}) {
  const t = useTranslations("dashboard")
  const [nameHovered, setNameHovered] = React.useState(false)
  const [optionsOpen, setOptionsOpen] = React.useState(false)
  const containsActiveSession = sessions.some((session) => session.id === activeSessionId)
  // The identity line is the second row and only carries the dimensions that
  // are filtered right now; `null` keeps the row exactly as it was before.
  const identityLine = projectIdentityLabel(identity, identityParts)
  const agentSummary = identity.agents
    .map((agent) => agent.sessionCount > 1 ? `${agent.label} ×${agent.sessionCount}` : agent.label)
    .join(", ")

  return (
    <SidebarMenuItem>
      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <TooltipProvider delayDuration={300}>
        <div
          className="group/project relative"
          onPointerEnter={() => setNameHovered(true)}
          onPointerLeave={() => setNameHovered(false)}
        >
          <CollapsibleTrigger asChild>
            <SidebarMenuButton
              className={cn(
                "pr-[4.75rem] text-muted-foreground",
                identityLine && "h-auto",
                containsActiveSession && "text-foreground",
              )}
            >
              {expanded ? <FolderOpen /> : <Folder />}
              {identityLine ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <OverflowMarquee
                        text={project.name}
                        active={nameHovered}
                        className="w-full flex-none"
                      />
                      <span className="block min-w-0 truncate text-[11px] leading-4 text-muted-foreground/80">
                        {identityLine}
                      </span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    sideOffset={6}
                    className="w-64 flex-col items-start gap-0.5"
                  >
                    <span className="truncate font-medium">{identity.deviceName}</span>
                    <span className="code-mono break-all text-[11px] opacity-80">
                      {identity.workspacePath}
                    </span>
                    {agentSummary ? (
                      <span className="text-[11px] opacity-80">{agentSummary}</span>
                    ) : null}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <OverflowMarquee text={project.name} active={nameHovered} />
              )}
            </SidebarMenuButton>
          </CollapsibleTrigger>

          <TooltipProvider delayDuration={300}>
            <div
              className={cn(
                "pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity",
                "group-hover/project:pointer-events-auto group-hover/project:opacity-100",
                "group-focus-within/project:pointer-events-auto group-focus-within/project:opacity-100",
                (containsActiveSession || optionsOpen) && "pointer-events-auto opacity-100",
              )}
            >
            <DropdownMenu open={optionsOpen} onOpenChange={setOptionsOpen}>
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
              <DropdownMenuContent align="end" collisionPadding={8} className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={onEdit}>
                    <Pencil />
                    {t("projects.edit")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onTogglePin}>
                    <Pin />
                    {project.pinned ? t("projects.unpin") : t("projects.pin")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" onSelect={onArchiveAll}>
                    <Archive />
                    {t("projects.archiveAll")}
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
        </TooltipProvider>

        <CollapsibleContent>
          <SidebarMenu>
            {sessions.length === 0 ? (
              <li className="py-2 pl-9 pr-3 text-xs text-muted-foreground">{t("projects.noSessions")}</li>
            ) : (
              sessions.map((session) => (
                <SessionSidebarItem
                  key={session.id}
                  item={session}
                  inset
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
