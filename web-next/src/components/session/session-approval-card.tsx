"use client"

import { Check, CircleAlert, CircleCheck, Info, Loader2, ShieldCheck, TriangleAlert, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Notice } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

type InteractionCardProps = {
  notice: Notice
  resolvingNoticeId: string | null
  resolvingActionId: string | null
  onRespondInteraction: (noticeId: string, actionId: string) => void
  compact?: boolean
}

export function InteractionCard({
  notice,
  resolvingNoticeId,
  resolvingActionId,
  onRespondInteraction,
  compact,
}: InteractionCardProps) {
  const resolving = resolvingNoticeId === notice.noticeId
  const disabled = resolvingNoticeId !== null || notice.status === "response_accepted" || notice.status === "resolving"
  const Icon = notice.severity === "error" ? CircleAlert : ShieldCheck
  return (
    <div className={cn(
      "rounded-xl border bg-card p-3 shadow-sm",
      notice.severity === "error" ? "border-destructive/35" : "border-border",
      compact && "rounded-lg",
    )}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 gap-2">
            <Icon className={cn(
              "mt-0.5 size-4 shrink-0",
              notice.severity === "error" ? "text-destructive" : "text-muted-foreground",
            )} />
            <div className="min-w-0">
              <div className="wrap-break-word text-sm font-medium">{notice.title}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 md:justify-end md:flex-nowrap">
            {notice.actions.map((action) => (
              <Button
                key={action.actionId}
                variant={action.style === "primary" ? "default" : "outline"}
                size="sm"
                className="whitespace-nowrap"
                disabled={disabled}
                onClick={() => onRespondInteraction(notice.noticeId, action.actionId)}
              >
                {resolving && resolvingActionId === action.actionId
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : actionIcon(action.actionId)}
                {action.label}
              </Button>
            ))}
          </div>
        </div>
        {notice.message || notice.status === "failed" ? (
          <div className="min-w-0 pl-6">
            {notice.message ? (
              <p className="wrap-break-word text-sm text-muted-foreground">{notice.message}</p>
            ) : null}
            {notice.status === "failed" ? (
              <p className="mt-1 text-xs text-destructive">{interactionErrorMessage(notice)}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function InteractionHeaderNotice({
  blockingInteractionCount,
  onResolveClick,
}: {
  blockingInteractionCount: number
  onResolveClick: () => void
}) {
  const tSession = useTranslations("dashboard.session")

  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-20 px-4 pt-2">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/70 px-3 py-2 text-sm shadow-lg shadow-background/20 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-2 text-foreground">
          <ShieldCheck className="size-4 shrink-0 text-amber-500" />
          <span className="min-w-0 truncate">
            {tSession(blockingInteractionCount > 1 ? "interactionPendingPlural" : "interactionPending", {
              count: blockingInteractionCount,
            })}
          </span>
        </div>
        <button
          type="button"
          className="pointer-events-auto shrink-0 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={onResolveClick}
        >
          {tSession("resolveBelow")}
        </button>
      </div>
    </div>
  )
}

export function NotificationCard({ notice }: { notice: Notice }) {
  const Icon = notificationIcon(notice.severity)
  return (
    <div className={cn(
      "rounded-xl border bg-muted/25 p-3",
      notice.severity === "error" && "border-destructive/35 bg-destructive/5",
      notice.severity === "warning" && "border-amber-500/30 bg-amber-500/5",
      notice.severity === "success" && "border-emerald-500/30 bg-emerald-500/5",
    )}>
      <div className="flex min-w-0 gap-2">
        <Icon className={cn(
          "mt-0.5 size-4 shrink-0",
          notice.severity === "error" && "text-destructive",
          notice.severity === "warning" && "text-amber-500",
          notice.severity === "success" && "text-emerald-500",
          notice.severity === "info" && "text-muted-foreground",
        )} />
        <div className="min-w-0">
          <div className="wrap-break-word text-sm font-medium">{notice.title}</div>
          {notice.message ? (
            <p className="mt-0.5 wrap-break-word text-sm text-muted-foreground">{notice.message}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function actionIcon(actionId: string) {
  if (actionId === "reject" || actionId === "cancel" || actionId === "dismiss") return <X className="size-3.5" />
  if (actionId === "approve_for_session") return <ShieldCheck className="size-3.5" />
  return <Check className="size-3.5" />
}

function notificationIcon(severity: Notice["severity"]) {
  if (severity === "error") return CircleAlert
  if (severity === "warning") return TriangleAlert
  if (severity === "success") return CircleCheck
  if (severity === "info") return Info
  return Info
}

function interactionErrorMessage(notice: Notice): string {
  const error = notice.context.error
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return "The response failed. Choose an action again."
}
