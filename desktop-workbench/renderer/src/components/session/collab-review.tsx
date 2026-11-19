"use client"

import * as React from "react"
import { ChevronDown, GitPullRequest } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useOptionalWorkspace } from "@/components/workspace-context"
import { CollabSessionLink } from "@/components/session/collab-timeline"
import { InteractionCard } from "@/components/session/session-approval-card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { CollabReview } from "@/features/collab/model"
import { dashboardApi } from "@/features/dashboard/api"
import type { Notice } from "@/features/dashboard/types"

export function CollabReviewProgress({ review, token = "", sessionId, panel = false }: { review: CollabReview; token?: string; sessionId?: string; panel?: boolean }) {
  const t = useTranslations("collab.review")
  const workspace = useOptionalWorkspace()
  const deviceName = (id: string) => workspace?.connectors.find(device => device.id === id)?.name ?? id
  const { attention } = review
  const current = review.rounds.at(-1)
  const attentionKey = attention ? `attention.${attention.code}` : null
  const localizedAttention = attentionKey && t.has(attentionKey) ? t(attentionKey) : null
  const showAttentionDetail = attention && (!localizedAttention || ["waiting_approval", "review_commit_unavailable"].includes(attention.code))
  const noticeId = attention?.noticeId
  const noticeTarget = attention?.target?.sessionId
  const [retrying, setRetrying] = React.useState(false)
  const retry = () => {
    if (!token || !sessionId || retrying) return
    setRetrying(true)
    void dashboardApi.sendSessionMessage(token, sessionId, t("resumeMessage"), { clientMessageId: crypto.randomUUID() }).then(result => {
      if (!result.ok) toast.error(result.error?.message ?? t("resumeFailed"))
    }).catch(() => toast.error(t("resumeFailed"))).finally(() => setRetrying(false))
  }

  return (
    <section className="flex min-w-0 flex-col gap-3 border-y py-3 text-sm" aria-label={t("title")}>
      <div className="flex flex-wrap items-center gap-2" role="status">
        <GitPullRequest className="size-4" aria-hidden />
        <span className="font-medium">{t("title")}</span>
        <Badge variant={review.phase === "delivered" ? "secondary" : "outline"}>{t(`phase.${review.phase}`)}</Badge>
        {current ? <code title={current.sha}>{current.sha.slice(0, 12)}</code> : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        {review.codeSession ? (
          <CollabSessionLink sessionId={review.codeSession.sessionId}>{t("implementation", { device: deviceName(review.implementationDeviceId) })}</CollabSessionLink>
        ) : <span>{t("implementation", { device: deviceName(review.implementationDeviceId) })}</span>}
        {current?.reviewer ? (
          <CollabSessionLink sessionId={current.reviewer.sessionId}>{t("reviewer", { runtime: review.reviewRuntimeType === "pi" ? "Pi" : "Claude Code", device: deviceName(review.reviewDeviceId) })}</CollabSessionLink>
        ) : <span>{t("reviewer", { runtime: review.reviewRuntimeType === "pi" ? "Pi" : "Claude Code", device: deviceName(review.reviewDeviceId) })}</span>}
      </div>
      {attention ? (
        <Alert>
          <AlertDescription>
            <p className="font-medium">{localizedAttention ?? t("attention.default")}</p>
            {attention.message && showAttentionDetail ? <p className="break-words">{attention.message}</p> : null}
            {attention.target ? <CollabSessionLink sessionId={attention.target.sessionId}>{t("openSource")}</CollabSessionLink> : null}
            {token && sessionId && !attention.noticeId && attention.code !== "review_a2a_legacy_run" && review.phase !== "blocked" ? <Button variant="outline" size="sm" disabled={retrying} onClick={retry}>{t("resume")}</Button> : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {token && noticeId && noticeTarget ? (
        <ReviewInteraction key={`${noticeTarget}:${noticeId}`} token={token} sessionId={noticeTarget} noticeId={noticeId} />
      ) : null}
      {[...review.rounds].reverse().map(round => (
        <Collapsible key={round.number} defaultOpen={round === current && (panel || review.phase === "delivered")}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              <ChevronDown data-icon="inline-start" aria-hidden />
              {t("round", { number: round.number, sha: round.sha.slice(0, 12) })}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 flex min-w-0 flex-col gap-2">
            <ReviewDetail label={t("changes")}>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{round.changes.summary}</pre>
              {round.changes.patch ? <pre className="max-h-96 overflow-auto whitespace-pre text-xs">{round.changes.patch}</pre> : null}
              {round.changes.truncated ? <p>{t("partialDiff")}</p> : null}
              {review.codeSession ? <CollabSessionLink sessionId={review.codeSession.sessionId}>{t("openImplementation")}</CollabSessionLink> : null}
            </ReviewDetail>
            {round.review ? (
              <ReviewDetail label={t("verdict")}>
                <p className="font-medium">{t(round.review.approved ? "approved" : "changesRequested")}</p>
                <p className="whitespace-pre-wrap break-words">{round.review.summary}</p>
                {round.review.blockers.length > 0 ? <ul className="list-disc pl-5">{round.review.blockers.map((finding, index) => <li key={index} className="break-words">{finding}</li>)}</ul> : null}
                {round.reviewer ? <CollabSessionLink sessionId={round.reviewer.sessionId}>{t("openReview")}</CollabSessionLink> : null}
              </ReviewDetail>
            ) : null}
            <ReviewDetail label={t("checks")}>
              {!round.checksComplete ? <p>{t("checksIncomplete")}</p> : null}
              <ul className="flex flex-col gap-1">
                {round.checks.map((check, index) => (
                  <li className="flex flex-wrap gap-x-2" key={index}>
                    <code className="break-all">{check.command}</code>
                    <span>{check.exitCode === 0 ? t("checkPassed") : t("checkFailed", { code: check.exitCode })}</span>
                  </li>
                ))}
              </ul>
            </ReviewDetail>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </section>
  )
}

function ReviewDetail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="outline" size="sm">{label}</Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex min-w-0 flex-col gap-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function ReviewInteraction({ token, sessionId, noticeId }: { token: string; sessionId: string; noticeId: string }) {
  const t = useTranslations("collab.review")
  const [notice, setNotice] = React.useState<Notice | null>(null)
  const [action, setAction] = React.useState<string | null>(null)
  React.useEffect(() => {
    let current = true
    void dashboardApi.getSessionRuntimeNotices(token, sessionId).then(result => {
      if (current) setNotice(result.notices.find(item => item.noticeId === noticeId && item.status === "open") ?? null)
    }).catch(() => {})
    return () => { current = false }
  }, [noticeId, sessionId, token])
  if (!notice) return null
  return (
    <InteractionCard notice={notice} resolvingNoticeId={action ? noticeId : null} resolvingActionId={action}
      onRespondInteraction={(_, actionId, input) => {
        if (action) return
        setAction(actionId)
        void dashboardApi.respondInteraction(token, sessionId, noticeId, actionId, input).then(result => {
          if (result.ok) setNotice(null)
          else toast.error(result.error?.message ?? t("approvalFailed"))
        }).catch(() => toast.error(t("approvalFailed"))).finally(() => setAction(null))
      }} />
  )
}
