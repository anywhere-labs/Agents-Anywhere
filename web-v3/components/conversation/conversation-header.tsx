"use client"

// The conversation's top bar (client-experience-proposal §2.4; v2 session-view-header): the sidebar button (on phones,
// and with a new-conversation button while the sidebar is folded away);
// the agent's icon and the title (click to rename in place: Enter saves, Esc cancels), its state and lock, then where it
// runs (device · project) in quieter type; then the side-panel toggle and the menu — rename, pin, fork, compact context,
// details, copy ID, export, open device, delete.
import Link from "next/link"
import { useState } from "react"
import {
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  GitForkIcon,
  InfoIcon,
  LaptopIcon,
  LoaderCircleIcon,
  PanelRightIcon,
  PencilIcon,
  PinIcon,
  ShrinkIcon,
  Trash2Icon,
} from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AgentIcon } from "@/components/workbench/agent-icon"
import { E2eeLockBadge } from "@/components/workbench/e2ee-lock-badge"
import { SidebarReopen } from "@/components/workbench/sidebar-reopen"
import type { SessionState } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { deviceHref, projectName, tildePath } from "@/lib/workbench/tree"

export interface HeaderActions {
  rename: (title: string) => Promise<void>
  togglePin: () => void
  fork?: () => void
  compact?: () => void
  details: () => void
  copyId: () => void
  exportJson: () => void
  remove: () => void
}

export function ConversationHeader({
  title,
  deviceId,
  deviceName,
  agent,
  agentName,
  cwd,
  state,
  encrypted,
  paired,
  pinned,
  panelOpen,
  onTogglePanel,
  canCompact,
  pendingCount,
  readOnly,
  actions,
}: {
  title: string
  deviceId: string
  deviceName?: string
  /** The agent's id, for its icon before the title; `agentName` names it (tooltip). */
  agent?: string
  agentName?: string
  cwd?: string
  state?: SessionState
  encrypted: boolean
  paired: boolean
  pinned: boolean
  panelOpen: boolean
  onTogglePanel: () => void
  canCompact: boolean
  pendingCount: number
  readOnly: boolean
  actions: HeaderActions
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState<string | null>(null)

  const commitRename = async () => {
    const next = editing?.trim()
    setEditing(null)
    if (next && next !== title) await actions.rename(next)
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 px-3 sm:px-4">
      <SidebarReopen />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* The conversation first, like any chat app, behind its agent's icon; where it runs follows in quieter type. */}
        {agent && (
          <span role="img" aria-label={agentName ?? agent} title={agentName ?? agent} className="-mr-1.5 flex shrink-0 pl-1">
            <AgentIcon agent={agent} name={agentName} className="text-foreground" />
          </span>
        )}
        {editing !== null ? (
          <input
            autoFocus
            value={editing}
            aria-label={t("conv.renameTitle")}
            placeholder={t("conv.renamePlaceholder")}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === "Enter") {
                e.preventDefault()
                void commitRename()
              } else if (e.key === "Escape") {
                e.preventDefault()
                setEditing(null)
              }
            }}
            className="h-8 max-w-md min-w-0 flex-1 rounded-full bg-card px-3 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        ) : (
          <button
            type="button"
            disabled={readOnly}
            title={t("conv.rename")}
            onClick={() => setEditing(title)}
            className="h-8 max-w-md min-w-0 shrink truncate rounded-full px-2 text-left text-sm font-medium text-foreground hover:bg-surface-hover disabled:hover:bg-transparent"
          >
            {title}
          </button>
        )}
        {state === "running" && <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        {state === "error" && (
          <Badge variant="destructive" className="shrink-0">
            {t("sessions.stateError")}
          </Badge>
        )}
        {pendingCount > 0 && (
          <Badge variant="warning" className="shrink-0">
            {t("conv.pendingCount", { count: pendingCount })}
          </Badge>
        )}
        {encrypted && <E2eeLockBadge paired={paired} compact className="shrink-0" />}
        <nav
          aria-label={t("conv.details")}
          className="hidden min-w-0 shrink-[2] items-center gap-1.5 text-sm text-muted-foreground md:flex"
        >
          <Link href={deviceHref(deviceId)} className="min-w-0 truncate transition-colors hover:text-foreground">
            {deviceName ?? deviceId}
          </Link>
          {cwd && (
            <>
              <span aria-hidden className="hidden shrink-0 lg:inline">·</span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Link
                      href={`${deviceHref(deviceId, "conversations")}&cwd=${encodeURIComponent(cwd)}`}
                      className="hidden max-w-48 min-w-0 truncate transition-colors hover:text-foreground lg:inline"
                    />
                  }
                >
                  {projectName(cwd)}
                </TooltipTrigger>
                <TooltipContent>
                  <span className="font-mono">{tildePath(cwd)}</span>
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </nav>
      </div>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("conv.togglePanel")}
              aria-pressed={panelOpen}
              className={cn(panelOpen && "bg-surface-hover")}
              onClick={onTogglePanel}
            />
          }
        >
          <PanelRightIcon className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{t("conv.togglePanel")}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("conv.more")} />}>
          <EllipsisIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem disabled={readOnly} onClick={() => setEditing(title)}>
            <PencilIcon />
            {t("conv.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={actions.togglePin}>
            <PinIcon />
            {pinned ? t("wb.unpin") : t("wb.pin")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={readOnly || !actions.fork} onClick={actions.fork}>
            <GitForkIcon />
            {t("conv.fork")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={readOnly || !canCompact || !actions.compact} onClick={actions.compact}>
            <ShrinkIcon />
            {canCompact ? t("conv.compact") : t("conv.compactUnsupported")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={actions.details}>
            <InfoIcon />
            {t("conv.details")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={actions.copyId}>
            <CopyIcon />
            {t("conv.copyId")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={actions.exportJson}>
            <DownloadIcon />
            {t("conv.exportJson")}
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href={deviceHref(deviceId)} />}>
            <LaptopIcon />
            {t("conv.openDevice")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={readOnly} onClick={actions.remove}>
            <Trash2Icon />
            {t("conv.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
