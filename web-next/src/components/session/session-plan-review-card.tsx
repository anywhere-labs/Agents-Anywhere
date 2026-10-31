"use client"

import * as React from "react"
import { Check, ClipboardList, Loader2, Maximize2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { MarkdownText } from "@/components/markdown-text"
import { Button } from "@/components/ui/button"
import { usePlanDraft, useSessionFilePreviewOpener } from "@/components/session/session-file-preview-context"
import { Textarea } from "@/components/ui/textarea"
import type { InteractionCardProps } from "@/components/session/session-approval-card"

export function PlanReviewCard({
  notice,
  resolvingNoticeId,
  onRespondInteraction,
}: InteractionCardProps) {
  const isCodex = notice.source.component === "codex.plan_review"
  const t = useTranslations("dashboard.session")
  const openFilePreview = useSessionFilePreviewOpener()
  const draft = usePlanDraft(notice.noticeId, notice.message ?? "")
  const { text: plan, loaded: documentLoaded } = React.useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot)
  const [permission, setPermission] = React.useState("approve_manual")
  const [editingFeedback, setEditingFeedback] = React.useState(false)
  const [feedback, setFeedback] = React.useState("")
  React.useEffect(() => {
    setPermission("approve_manual")
    setFeedback("")
    setEditingFeedback(false)
  }, [notice.noticeId])

  const resolving = resolvingNoticeId === notice.noticeId
  const pending = notice.responseRequired
  const disabled = resolvingNoticeId !== null || !pending || !documentLoaded
    || ["responding", "response_accepted", "resolving"].includes(notice.status)
  const mode = notice.context.automatedPermissionMode
  const automatedLabel = mode === "auto" ? t("planApproveAuto")
    : mode === "bypassPermissions" ? t("planApproveBypass") : t("planApproveEdits")
  const automatedDescription = mode === "auto" ? t("planAutoDescription")
    : mode === "bypassPermissions" ? t("planBypassDescription") : t("planEditsDescription")
  const status = resolving || ["responding", "response_accepted", "resolving"].includes(notice.status)
    ? t("planSubmitting")
    : pending ? t("planAwaitingReview")
    : notice.status === "resolved"
      ? notice.context.responseActionId === "revise_plan" ? t("planFeedbackSent") : t("planApproved")
      : t("planClosed")
  const feedbackId = `${notice.noticeId}-plan-feedback`

  return (
    <section aria-label={t("planReviewTitle")} className="min-w-0 overflow-hidden rounded-xl border border-primary/30 bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/15 bg-primary/5 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardList className="size-4 text-primary" aria-hidden="true" />
          <span>{t("planReviewTitle")}</span>
          <span className="text-xs font-normal text-muted-foreground">{isCodex ? "Codex" : "Claude"}</span>
        </div>
        <div className="flex items-center gap-2">
          <span role="status" className="rounded-full border border-primary/20 bg-background px-2 py-0.5 text-xs text-muted-foreground">{status}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("planViewFull")} title={t("planViewFull")} disabled={!openFilePreview} onClick={() => openFilePreview?.({ source: "plan", name: t("planReviewTitle"), path: notice.noticeId, root: "", planDraft: draft })}>
            <Maximize2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </header>
      <div className="relative h-48 overflow-hidden" aria-hidden="true" inert>
        <div className="px-4 py-4">
          {notice.message ? <MarkdownText text={plan} /> : null}
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />
      </div>
      {notice.actions.length > 0 ? (
        <div className="space-y-2 border-t border-border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {!isCodex ? <>
            <label className="sr-only" htmlFor={`${notice.noticeId}-permission`}>{t("planExecutionPermission")}</label>
            <select id={`${notice.noticeId}-permission`} value={permission} disabled={disabled}
              onChange={event => setPermission(event.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              title={permission === "approve_manual" ? t("planManualDescription") : automatedDescription}>
              <option value="approve_manual">{t("planManualCompact")}</option>
              <option value="approve_automated">{automatedLabel}</option>
            </select>
            </> : null}
            <Button type="button" size="sm" variant="outline" disabled={disabled || !plan.trim()}
              onClick={() => onRespondInteraction(notice.noticeId, isCodex ? "implement_plan" : permission, { plan: draft.getSnapshot().text })}>
              {resolving ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Check className="size-3.5" aria-hidden="true" />}
              {t("planApproveExecute")}
            </Button>
            <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50"
              disabled={disabled} aria-expanded={editingFeedback} onClick={() => setEditingFeedback(!editingFeedback)}>
              {isCodex ? t("planAskCodex") : t("planAskClaude")}
            </button>
          </div>
          {editingFeedback ? (
            <div className="space-y-2 pt-1">
              <label htmlFor={feedbackId} className="sr-only">{t("planFeedbackLabel")}</label>
              <Textarea id={feedbackId} value={feedback} onChange={(event) => setFeedback(event.target.value)}
                placeholder={t("planFeedbackPlaceholder")} disabled={disabled} rows={2} className="resize-y bg-background" />
              <Button type="button" size="sm" variant="outline" disabled={disabled || !feedback.trim()}
                onClick={() => onRespondInteraction(notice.noticeId, "revise_plan", { feedback: feedback.trim(), plan: draft.getSnapshot().text })}>
                {t("planSubmit")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {notice.status === "failed" ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">{t("planResponseFailed")}</p>
      ) : null}
    </section>
  )
}
