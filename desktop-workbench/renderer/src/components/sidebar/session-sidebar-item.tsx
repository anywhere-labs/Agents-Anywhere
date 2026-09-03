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
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

export function SessionPageTrigger({
  loading,
  label,
  onVisible,
}: {
  loading: boolean
  label: string
  onVisible: () => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const onVisibleRef = React.useRef(onVisible)
  onVisibleRef.current = onVisible

  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !loading) onVisibleRef.current()
      },
      { rootMargin: "160px 0px" },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [loading])

  return (
    <div ref={ref} className="flex h-9 items-center justify-center" aria-label={label}>
      {loading ? <Spinner className="size-4 text-muted-foreground" /> : null}
    </div>
  )
}

export function SessionSidebarItem({
  item,
  isActive,
  onOpen,
  onTogglePin,
  onToggleArchive,
  onRename,
}: {
  item: { id: string; title?: string | null; status: string; unread: boolean; pinned: boolean; archived: boolean }
  isActive: boolean
  onOpen: () => void
  onTogglePin: () => void
  onToggleArchive: () => void
  onRename: (title: string) => Promise<boolean>
}) {
  const t = useTranslations("dashboard")
  const tSession = useTranslations("dashboard.session")
  const tCommon = useTranslations("common")
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState(item.title ?? "")
  const [renaming, setRenaming] = React.useState(false)
  const isBusy = item.status === "running" || item.status === "waiting" || item.status === "pending"
  const isWaitingApproval = item.status === "waiting_approval"
  const isUnreadIdle = item.unread && item.status === "idle"
  const hasStatusIndicator = isBusy || isWaitingApproval || isUnreadIdle

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
        <SidebarMenuItem className="group/session">
          <ContextMenuTrigger asChild>
            <div>
              <SidebarMenuButton
                isActive={isActive}
                onClick={onOpen}
                className={cn(
                  "text-muted-foreground data-[active=true]:text-foreground",
                  !hasStatusIndicator && "group-hover/session:pr-[4.25rem] group-focus-within/session:pr-[4.25rem]",
                  isActive && !hasStatusIndicator && "pr-[4.25rem]",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <SessionSidebarIndicator
                  busy={isBusy}
                  unreadIdle={isUnreadIdle}
                  waitingApproval={isWaitingApproval}
                />
              </SidebarMenuButton>
            </div>
          </ContextMenuTrigger>

          {!hasStatusIndicator ? (
            <TooltipProvider delayDuration={300}>
              <div
                className={cn(
                  "absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5",
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
            <DialogFooter className="gap-2 sm:gap-2">
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
