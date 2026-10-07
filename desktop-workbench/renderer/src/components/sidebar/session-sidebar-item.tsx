"use client"

import * as React from "react"
import { Archive, Copy, FolderOpen, Pencil, Pin } from "lucide-react"
import { toast } from "sonner"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { SessionAgentIcon } from "@/components/sidebar/session-agent-icon"
import { OverflowMarquee } from "@/components/sidebar/overflow-marquee"
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"
import { useWorkspace } from "@/components/workspace-context"

/** Session status → `dashboard.sessionStatus.*` message key for the
 *  in-progress status chip. */
const SESSION_STATUS_LABEL_KEYS: Record<string, string> = {
  running: "running",
  waiting: "waiting",
  pending: "pending",
  stopping: "stopping",
  waiting_approval: "waitingApproval",
  blocked: "blocked",
}


export function SessionSidebarItem({
  item,
  meta = null,
  inset = false,
  previousConnectorId = null,
  isActive,
  onOpen,
  onTogglePin,
  onToggleArchive,
  onRename,
}: {
  item: { runtime: string; runtimeType?: string; id: string; connectorId: string; projectId?: string | null; cwd?: string | null; title?: string | null; status: string; unread: boolean; pinned: boolean; archived: boolean }
  /** Optional `device · agent` identity line for sessions shown outside projects. */
  meta?: string | null
  inset?: boolean
  /** Device of the row above; a repeated device collapses to `^`. */
  previousConnectorId?: string | null
  isActive: boolean
  onOpen: () => void
  onTogglePin: () => void
  onToggleArchive: () => void
  onRename: (title: string) => Promise<boolean>
}) {
  const t = useTranslations("dashboard")
  const tSession = useTranslations("dashboard.session")
  const tCommon = useTranslations("common")
  const { connectors, projects, sidebarShowsSessions, sidebarCompactSessions, filter } = useWorkspace()
  const deviceName = connectors.find((connector) => connector.id === item.connectorId)?.name ?? item.connectorId
  const projectName = projects.find((project) => project.id === item.projectId)?.name
    || item.cwd?.split(/[\\/]/).filter(Boolean).pop()
  const deviceLabel = previousConnectorId === item.connectorId ? "^" : deviceName
  const contextLabel = [projectName, deviceLabel].filter(Boolean).join(" · ")
  const showContext = sidebarShowsSessions && !sidebarCompactSessions && !inset && Boolean(contextLabel)
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState(item.title ?? "")
  const [renaming, setRenaming] = React.useState(false)
  const [nameHovered, setNameHovered] = React.useState(false)
  const isBusy = item.status === "running" || item.status === "waiting" || item.status === "pending"
  const isWaitingApproval = item.status === "waiting_approval"
  const isUnreadIdle = item.unread && item.status === "idle"
  const hasStatusIndicator = isBusy || isWaitingApproval || isUnreadIdle
  // In the "in progress" view every row names its live status so the sidebar
  // works as a per-device Agent status board.
  const statusChipLabel = filter?.status === "working" && SESSION_STATUS_LABEL_KEYS[item.status]
    ? t(`sessionStatus.${SESSION_STATUS_LABEL_KEYS[item.status]}`)
    : null

  React.useEffect(() => {
    if (!renameOpen) setTitleDraft(item.title ?? "")
  }, [item.title, renameOpen])

  const cancelRename = React.useCallback(() => {
    setTitleDraft(item.title ?? "")
    setRenameOpen(false)
  }, [item.title])

  const submitRename = React.useCallback(async () => {
    const nextTitle = titleDraft.trim()
    if (!nextTitle) {
      cancelRename()
      return
    }
    if (renaming) return
    if (nextTitle === item.title) {
      setRenameOpen(false)
      return
    }
    setRenaming(true)
    try {
      const ok = await onRename(nextTitle)
      if (ok) setRenameOpen(false)
      else toast.error(tSession("renameFailed"))
    } finally {
      setRenaming(false)
    }
  }, [cancelRename, item.title, onRename, renaming, tSession, titleDraft])

  const copySessionId = async () => {
    try {
      await copyText(item.id)
      toast.success(t("actions.copiedSessionId"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("actions.copyFailed"))
    }
  }

  return (
    <>
      <ContextMenu>
        {/* Session rows bleed through the group and content padding so the
            selection reads as a full-width bar. */}
        <SidebarMenuItem
          className="group/session -mx-4"
          onPointerEnter={() => setNameHovered(true)}
          onPointerLeave={() => setNameHovered(false)}
        >
          <ContextMenuTrigger asChild>
            <div>
              <SidebarMenuButton
                isActive={isActive}
                onClick={onOpen}
                className={cn(
                  "rounded-none px-7 text-muted-foreground data-[active=true]:text-foreground",
                  (showContext || meta) && "h-auto flex-col items-stretch gap-1",
                  inset && "pl-8.5 has-[>svg:first-child]:pl-8.5",
                  !hasStatusIndicator && "group-hover/session:pr-[5.25rem] group-focus-within/session:pr-[5.25rem]",
                  isActive && !hasStatusIndicator && "pr-[5.25rem]",
                )}
              >
                <span className="flex min-w-0 w-full items-center gap-2">
                  <SessionAgentIcon runtime={item.runtime} runtimeType={item.runtimeType} />
                  <OverflowMarquee text={item.title ?? ""} active={nameHovered} />
                  <SessionSidebarIndicator
                    busy={isBusy}
                    unreadIdle={isUnreadIdle}
                    waitingApproval={isWaitingApproval}
                  />
                </span>
                {showContext ? (
                  <OverflowMarquee
                    text={contextLabel}
                    active={nameHovered}
                    className="w-full flex-none text-xs font-normal text-muted-foreground"
                  />
                ) : null}
                {meta ? (
                  <span className="block w-full min-w-0 truncate text-[11px] leading-4 text-muted-foreground/80">
                    {meta}
                  </span>
                ) : null}
                {statusChipLabel ? (
                  <span className="block w-full min-w-0 truncate text-[11px] leading-4 text-muted-foreground/70">
                    {statusChipLabel}
                  </span>
                ) : null}
              </SidebarMenuButton>
            </div>
          </ContextMenuTrigger>

          {showContext ? (
            <div className="pointer-events-none absolute inset-x-7 bottom-0 group-last/session:hidden">
              <Separator />
            </div>
          ) : null}

          {!hasStatusIndicator ? (
            <TooltipProvider delayDuration={300}>
              <div
                className={cn(
                  "absolute right-5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5",
                  (showContext || meta) && "top-4",
                  "group-hover/session:flex group-focus-within/session:flex",
                  isActive && "flex",
                )}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={item.pinned ? t("actions.unpinChat") : t("actions.pinChat")}
                      onClick={(e) => {
                        e.stopPropagation()
                        onTogglePin()
                      }}
                      className={cn(
                        "rounded p-1 transition-colors hover:bg-sidebar-accent/65 hover:text-foreground",
                        item.pinned ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      <Pin className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {item.pinned ? t("actions.unpinChat") : t("actions.pinChat")}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={item.archived ? t("actions.unarchiveChat") : t("actions.archiveChat")}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleArchive()
                      }}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent/65 hover:text-foreground"
                    >
                      <Archive className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {item.archived ? t("actions.unarchiveChat") : t("actions.archiveChat")}
                  </TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
          ) : null}
        </SidebarMenuItem>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={onOpen}>
            <FolderOpen className="size-4" />
            {t("actions.open")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil className="size-4" />
            {t("actions.rename")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onTogglePin}>
            <Pin className="size-4" />
            {item.pinned ? t("actions.unpin") : t("actions.pin")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onToggleArchive}>
            <Archive className="size-4" />
            {item.archived ? t("actions.unarchive") : t("actions.archive")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void copySessionId()}>
            <Copy className="size-4" />
            {t("actions.copySessionId")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={renameOpen} onOpenChange={(open: boolean) => {
        if (open) {
          setTitleDraft(item.title ?? "")
          setRenameOpen(true)
        } else {
          cancelRename()
        }
      }}>
        <DialogContent className="sm:max-w-sm">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submitRename()
            }}
          >
            <DialogHeader>
              <DialogTitle>{tSession("renameTitle")}</DialogTitle>
            </DialogHeader>
            <Input
              autoFocus
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === "Escape") {
                  event.preventDefault()
                  cancelRename()
                }
              }}
              disabled={renaming}
              aria-label={tSession("renameTitle")}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={cancelRename} disabled={renaming}>
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={renaming || titleDraft.trim().length === 0}>
                {tCommon("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

function SessionSidebarIndicator({
  busy,
  unreadIdle,
  waitingApproval,
}: {
  busy: boolean
  unreadIdle: boolean
  waitingApproval: boolean
}) {
  const t = useTranslations("dashboard")

  if (waitingApproval) {
    return (
      <span className="ml-2 shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium leading-4 text-emerald-400 ring-1 ring-emerald-500/20">
        {t("sessionStatus.waitingApproval")}
      </span>
    )
  }
  if (busy) {
    return (
      <span
        aria-label={t("sessionStatus.running")}
        className="ml-2 size-3.5 shrink-0 animate-spin rounded-full border-2 border-sidebar-foreground/25 border-t-sidebar-foreground/75"
      />
    )
  }
  if (unreadIdle) {
    return (
      <span
        aria-label={t("sessionStatus.unread")}
        className="ml-2 size-2 shrink-0 rounded-full bg-emerald-500"
      />
    )
  }
  return null
}
