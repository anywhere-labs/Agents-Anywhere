"use client"

// Timeline pieces for Agent collaboration: who sent a message an Agent wrote, supervision wake digests, decisions
// handed to the person, and links from collaboration tool calls to the sessions they touched.

import * as React from "react"
import { BellRing, Bot, ChevronDown, ExternalLink, MessageCircleQuestion } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useOptionalWorkspace } from "@/components/workspace-context"
import {
  SESSION_PLACEHOLDER,
  digestPreview,
  splitAroundPlaceholder,
  sessionTitleOf,
  shortSessionId,
  type CollabEscalation,
  type CollabToolCall,
  type MessageAuthor,
} from "@/features/collab/model"
import { cn } from "@/lib/utils"

/** Titles and navigation from the session list; absent on pages without a workspace (public shares). */
export function useCollabSessions() {
  const workspace = useOptionalWorkspace()
  const t = useTranslations("collab")
  const sessions = workspace?.sessions
  const openSession = workspace?.openSession
  return React.useMemo(() => ({
    title: (sessionId: string | null | undefined): string =>
      sessionTitleOf(sessions ?? [], sessionId) ?? (sessionId ? t("unknownSession", { id: shortSessionId(sessionId) }) : ""),
    open: openSession ?? null,
  }), [openSession, sessions, t])
}

export function CollabSessionLink({
  sessionId,
  children,
  className,
}: {
  sessionId: string
  children?: React.ReactNode
  className?: string
}) {
  const sessions = useCollabSessions()
  const label = children ?? sessions.title(sessionId)
  if (!sessions.open) return <span className={className}>{label}</span>
  return (
    <button
      type="button"
      className={cn("min-w-0 truncate font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm", className)}
      onClick={(event) => {
        event.stopPropagation()
        sessions.open?.(sessionId)
      }}
    >
      {label}
    </button>
  )
}

/** The small line above a user message an Agent sent from another session. */
export function AgentAuthorLabel({ author }: { author: MessageAuthor }) {
  const t = useTranslations("collab.author")
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1 text-xs text-muted-foreground" data-slot="collab-author">
      <Bot className="size-3 shrink-0" aria-hidden />
      {author.sessionId ? (
        <SessionSentence template={t("sentByAgent", { title: SESSION_PLACEHOLDER })} sessionId={author.sessionId} />
      ) : (
        <span>{t("sentByAgentUnknown")}</span>
      )}
    </div>
  )
}

/** A supervision wake digest sent to the supervisor session: not the person's own bubble. */
export function SupervisionNoticeCard({ text }: { text: string }) {
  const t = useTranslations("collab.supervisionNotice")
  const [open, setOpen] = React.useState(false)
  const { preview, truncated } = React.useMemo(() => digestPreview(text), [text])
  return (
    <section
      className="w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-sky-500/30 bg-sky-500/5 text-sm"
      data-slot="collab-supervision-notice"
      aria-label={t("title")}
    >
      <header className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs font-medium text-sky-700 dark:text-sky-300">
        <BellRing className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0">{t("title")}</span>
        {truncated ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 gap-1 px-2 text-xs font-normal"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t("collapse") : t("expand")}
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
          </Button>
        ) : null}
      </header>
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-xs leading-relaxed text-foreground/90">
        {open || !truncated ? text : preview}
      </pre>
    </section>
  )
}

/** A decision an Agent handed to the person. */
export function CollabEscalationCard({ escalation }: { escalation: CollabEscalation }) {
  const t = useTranslations("collab.escalation")
  return (
    <section
      role="note"
      className="w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
      data-slot="collab-escalation"
    >
      <header className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
        <MessageCircleQuestion className="size-4 shrink-0" aria-hidden />
        {t("title")}
      </header>
      <p className="mt-2 whitespace-pre-wrap break-words font-medium text-foreground">{escalation.question}</p>
      {escalation.context ? (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground">{t("context")}</div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground/90">{escalation.context}</p>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {escalation.fromSessionId ? (
          <SessionSentence template={t("from", { title: SESSION_PLACEHOLDER })} sessionId={escalation.fromSessionId} />
        ) : null}
        {escalation.targetSessionId && escalation.targetSessionId !== escalation.fromSessionId ? (
          <SessionSentence template={t("target", { title: SESSION_PLACEHOLDER })} sessionId={escalation.targetSessionId} />
        ) : null}
      </div>
    </section>
  )
}

/** A translated sentence whose session placeholder is rendered as a link to that session. */
function SessionSentence({ template, sessionId }: { template: string; sessionId: string }) {
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1">
      {splitAroundPlaceholder(template, SESSION_PLACEHOLDER).map((part, index) =>
        part === null ? <CollabSessionLink key={index} sessionId={sessionId} className="text-foreground" /> : <span key={index} className="shrink-0">{part}</span>,
      )}
    </span>
  )
}

/** 「打开会话」 under a collaboration tool call that names a session. */
export function CollabToolSessionLink({ call }: { call: CollabToolCall }) {
  const t = useTranslations("collab")
  const sessions = useCollabSessions()
  if (!call.sessionId || !sessions.open) return null
  const sessionId = call.sessionId
  return (
    <div className="flex min-w-0 items-center gap-1.5 pl-6 text-xs text-muted-foreground" data-slot="collab-tool-session">
      <ExternalLink className="size-3 shrink-0" aria-hidden />
      <CollabSessionLink sessionId={sessionId} className="text-foreground">{t("openSession")}</CollabSessionLink>
      <span className="min-w-0 truncate">{sessions.title(sessionId)}</span>
    </div>
  )
}
