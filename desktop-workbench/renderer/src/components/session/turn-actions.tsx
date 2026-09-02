"use client"

import * as React from "react"
import { Check, Copy, Forward, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { dashboardApi } from "@/features/dashboard/api"
import type { SessionShareScope } from "@/features/dashboard/types"
import { cn } from "@/lib/utils"

export type TurnAction = {
  copyText: string
  itemIds: string[]
}

export function TurnActions({
  token,
  sessionId,
  action,
}: {
  token: string
  sessionId: string
  action: TurnAction
}) {
  const t = useTranslations("dashboard.session")
  const [copied, setCopied] = React.useState(false)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [scope, setScope] = React.useState<SessionShareScope>("message")
  const [sharing, setSharing] = React.useState(false)

  const copyReply = React.useCallback(async () => {
    if (!action.copyText) return
    try {
      await navigator.clipboard.writeText(action.copyText)
      setCopied(true)
      toast.success(t("replyCopied"))
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      toast.error(t("copyReplyFailed"))
    }
  }, [action.copyText, t])

  const createShare = React.useCallback(async () => {
    if (sharing) return
    setSharing(true)
    try {
      const result = await dashboardApi.createSessionShare(token, sessionId, {
        scope,
        itemIds: scope === "message" ? action.itemIds : [],
      })
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ url: result.shareUrl })
          setDialogOpen(false)
          return
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return
        }
      }
      await navigator.clipboard.writeText(result.shareUrl)
      toast.success(t("shareLinkCopied"))
      setDialogOpen(false)
    } catch {
      toast.error(t("shareFailed"))
    } finally {
      setSharing(false)
    }
  }, [action.itemIds, scope, sessionId, sharing, t, token])

  return (
    <>
      <div className="mt-1 border-t border-border/60 pt-1.5">
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("copyReply")}
            title={t("copyReply")}
            disabled={!action.copyText}
            onClick={copyReply}
            className="text-muted-foreground hover:text-foreground"
          >
            {copied ? <Check /> : <Copy />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("share")}
            title={t("share")}
            onClick={() => setDialogOpen(true)}
            className="text-muted-foreground hover:text-foreground"
          >
            <Forward />
          </Button>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!sharing) setDialogOpen(open) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("shareDialogTitle")}</DialogTitle>
            <DialogDescription>{t("shareDialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <ShareScopeOption
              selected={scope === "message"}
              title={t("shareCurrentReply")}
              description={t("shareCurrentReplyDescription")}
              onClick={() => setScope("message")}
            />
            <ShareScopeOption
              selected={scope === "session"}
              title={t("shareEntireSession")}
              description={t("shareEntireSessionDescription")}
              onClick={() => setScope("session")}
            />
          </div>
          <DialogFooter>
            <Button type="button" onClick={createShare} disabled={sharing}>
              {sharing ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Forward data-icon="inline-start" />}
              {t("createShareLink")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ShareScopeOption({
  selected,
  title,
  description,
  onClick,
}: {
  selected: boolean
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "rounded-lg border px-3 py-3 text-left transition-colors",
        selected ? "border-foreground/35 bg-accent" : "border-border hover:bg-accent/50",
      )}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{description}</span>
    </button>
  )
}
