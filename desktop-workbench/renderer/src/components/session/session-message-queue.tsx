"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { ArrowUp, Check, ChevronDown, ChevronUp, Hand, Loader2, Pencil, Trash2, X, createLucideIcon, type IconNode } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { editQueuedMessage, removeQueuedMessage, type QueuedMessage } from "@/components/session/message-queue"

// lucide 1.46 ships message-square-text but has no circular text bubble, so compose one
// from lucide's own message-circle geometry to keep the stroke identical to its siblings.
const messageCircleTextNode: IconNode = [
  ["path", { d: "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719", key: "1sd12s" }],
  ["path", { d: "M8 10h8", key: "qct8xl" }],
  ["path", { d: "M8 14h5", key: "1b9m1a" }],
]
const MessageCircleText = createLucideIcon("MessageCircleText", messageCircleTextNode)

export function SessionMessageQueue({ sessionId, messages, paused = false, canSendNow, onSendNow }: {
  sessionId: string
  messages: QueuedMessage[]
  paused?: boolean
  canSendNow: boolean
  onSendNow: (id: string) => void
}) {
  const t = useTranslations("dashboard.session")
  const [expanded, setExpanded] = React.useState(false)
  if (!messages.length) return null
  // A single message stays visible; several collapse into a count the user can open.
  // A paused queue always keeps its header so the stall cannot go unnoticed.
  const collapsible = messages.length > 1 || paused
  const editing = messages.some(message => message.editing)
  const showRows = !collapsible || expanded || editing
  const hasFailed = messages.some(message => message.status === "failed")
  return (
    <div className="mx-auto w-full max-w-[calc(48rem+2rem)] px-10">
      <div
        className="no-scrollbar max-h-60 overflow-y-auto rounded-t-2xl border border-b-0 border-border bg-muted text-xs"
        aria-live="polite"
      >
        {collapsible ? (
          <button
            type="button"
            aria-expanded={showRows}
            aria-label={t(showRows ? "queueCollapse" : "queueExpand")}
            disabled={editing}
            className={cn("flex w-full items-center gap-1 px-2 py-2 text-left hover:bg-background/40", showRows && "border-b border-border/60")}
            onClick={() => setExpanded(current => !current)}
          >
            <QueueStatusIcon
              status={hasFailed ? "failed" : "queued"}
              label={t(hasFailed ? "queueFailed" : "queued")}
            />
            <span className="min-w-0 flex-1 truncate font-medium">{t("queueCount", { count: messages.length })}</span>
            {paused ? <span className="shrink-0 text-muted-foreground">{t("queuePaused")}</span> : null}
            {showRows
              ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              : <ChevronUp className="size-4 shrink-0 text-muted-foreground" />}
          </button>
        ) : null}
        {showRows ? (
          <div className="divide-y divide-border/60 px-2 py-1">
            {messages.map(message => (
              <QueuedMessageRow key={message.id} sessionId={sessionId} message={message} paused={paused} canSendNow={canSendNow} onSendNow={onSendNow} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function QueueStatusIcon({ status, label }: { status: QueuedMessage["status"]; label: string }) {
  const shared = { role: "img" as const, "aria-label": label, title: label, className: "size-3.5 shrink-0" }
  if (status === "failed") return <MessageCircleText {...shared} className={cn(shared.className, "text-destructive")} />
  if (status === "sending") return <Loader2 {...shared} className={cn(shared.className, "animate-spin text-muted-foreground")} />
  if (status === "interrupting") return <Hand {...shared} className={cn(shared.className, "text-muted-foreground")} />
  return <MessageCircleText {...shared} className={cn(shared.className, "text-muted-foreground/70")} />
}

function QueuedMessageRow({ sessionId, message, paused, canSendNow, onSendNow }: {
  sessionId: string
  message: QueuedMessage
  paused: boolean
  canSendNow: boolean
  onSendNow: (id: string) => void
}) {
  const t = useTranslations("dashboard.session")
  const tNew = useTranslations("dashboard.new")
  const [draft, setDraft] = React.useState(message.content)
  const locked = message.status === "sending" || message.status === "interrupting"
  const statusLabel = t(message.status === "failed" ? "queueFailed" : message.status === "sending" ? "queueSending" : message.status === "interrupting" ? "queueInterrupting" : "queued")
  const attachmentNames = message.attachments.map(file => file.name).join(", ")
  const startEditing = () => { setDraft(message.content); editQueuedMessage(sessionId, message.id, true) }
  React.useEffect(() => () => { editQueuedMessage(sessionId, message.id, false) }, [sessionId, message.id])
  return (
    <div className="flex items-center gap-1">
      <QueueStatusIcon status={message.status} label={statusLabel} />
      {message.editing ? (
        <>
          <Textarea
            autoFocus
            aria-label={t("queueEdit")}
            value={draft}
            onChange={event => setDraft(event.currentTarget.value)}
            className="no-scrollbar h-6 min-h-0 min-w-0 flex-1 resize-none rounded-lg px-1.5 py-0.5 text-xs"
          />
          <div className="flex shrink-0 items-center gap-0.5">
            <Button size="icon-xs" variant="ghost" aria-label={t("queueSave")} title={t("queueSave")} disabled={!draft.trim() && message.attachments.length === 0} onClick={() => editQueuedMessage(sessionId, message.id, false, draft)}><Check className="size-4" /></Button>
            <Button size="icon-xs" variant="ghost" aria-label={t("queueCancel")} title={t("queueCancel")} onClick={() => editQueuedMessage(sessionId, message.id, false)}><X className="size-4" /></Button>
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            disabled={locked}
            aria-label={t("queueEdit")}
            title={message.content}
            className="min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left hover:bg-background/70 focus-visible:outline focus-visible:outline-ring"
            onClick={startEditing}
          >
            {message.content || tNew("attachmentOnlyPrompt")}
            {message.attachments.length > 0 ? ` (${attachmentNames})` : ""}
          </button>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button size="icon-xs" variant="ghost" disabled={locked} aria-label={t("queueEdit")} title={t("queueEdit")} onClick={startEditing}><Pencil /></Button>
            <Button size="icon-xs" variant="ghost" disabled={locked} aria-label={t("queueDelete")} title={t("queueDelete")} onClick={() => removeQueuedMessage(sessionId, message.id)}><Trash2 /></Button>
            <Button size="icon-xs" variant="ghost" disabled={locked || !canSendNow || paused} aria-label={t("queueSendNow")} title={paused ? t("queueSendNowPaused") : t("queueSendNow")} onClick={() => onSendNow(message.id)}><ArrowUp /></Button>
          </div>
        </>
      )}
    </div>
  )
}
