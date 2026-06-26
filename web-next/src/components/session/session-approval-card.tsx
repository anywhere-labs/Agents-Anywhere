"use client"

import { Check, Loader2, ShieldCheck, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Approval, ApprovalResolveStatus } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

type ApprovalCardProps = {
  approval: Approval
  resolvingApprovalId: string | null
  resolvingStatus: ApprovalResolveStatus | null
  onResolveApproval: (approvalId: string, status: ApprovalResolveStatus) => void
  compact?: boolean
}

export function ApprovalCard({
  approval,
  resolvingApprovalId,
  resolvingStatus,
  onResolveApproval,
  compact,
}: ApprovalCardProps) {
  const tSession = useTranslations("dashboard.session")
  const resolving = resolvingApprovalId === approval.id
  const disabled = resolvingApprovalId !== null
  return (
    <div className={cn("rounded-xl border border-border bg-muted/25 p-3", compact && "rounded-lg")}>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="wrap-break-word text-sm font-medium">{approval.title || tSession("approvalRequested")}</div>
            {approval.description ? (
              <p className="mt-0.5 wrap-break-word text-sm text-muted-foreground">{approval.description}</p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 md:flex-nowrap">
          {approval.choices.includes("reject") ? (
            <Button
              variant="outline"
              size="sm"
              className="whitespace-nowrap"
              disabled={disabled}
              onClick={() => onResolveApproval(approval.id, "rejected")}
            >
              {resolving && resolvingStatus === "rejected" ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
              {tSession("reject")}
            </Button>
          ) : null}
          {approval.choices.includes("approve_for_session") ? (
            <Button
              variant="outline"
              size="sm"
              className="whitespace-nowrap"
              disabled={disabled}
              onClick={() => onResolveApproval(approval.id, "approved_for_session")}
            >
              {resolving && resolvingStatus === "approved_for_session" ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
              {tSession("approveSession")}
            </Button>
          ) : null}
          {approval.choices.includes("approve") ? (
            <Button
              size="sm"
              className="whitespace-nowrap"
              disabled={disabled}
              onClick={() => onResolveApproval(approval.id, "approved")}
            >
              {resolving && resolvingStatus === "approved" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {tSession("approve")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function ApprovalHeaderNotice({
  pendingApprovalCount,
  onResolveClick,
}: {
  pendingApprovalCount: number
  onResolveClick: () => void
}) {
  const tSession = useTranslations("dashboard.session")

  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-20 px-4 pt-2">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/70 px-3 py-2 text-sm shadow-lg shadow-background/20 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-2 text-foreground">
          <ShieldCheck className="size-4 shrink-0 text-amber-500" />
          <span className="min-w-0 truncate">
            {tSession(pendingApprovalCount > 1 ? "approvalPendingPlural" : "approvalPending", {
              count: pendingApprovalCount,
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
