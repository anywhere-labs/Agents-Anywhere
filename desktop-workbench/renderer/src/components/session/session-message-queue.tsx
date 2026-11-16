"use client"

import * as React from "react"
import { AlertCircle, Check, ChevronDown, ChevronUp, Loader2, Pencil, RotateCw, SendHorizontal, Trash2, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { SessionQueueController } from "@/features/message-queue/use-session-queue"
import { queueItemEditable, queuePause, type QueueItemView } from "@/features/message-queue/queue-model"

const COLLAPSED_ITEMS = 2

/** Messages waiting for the session, shown above the composer. */
export function SessionMessageQueue({
  controller,
  runtimeStatus,
  canControl,
  canInterrupt,
}: {
  controller: SessionQueueController
  runtimeStatus: string | null | undefined
  canControl: boolean
  canInterrupt: boolean
}) {
  const t = useTranslations("dashboard.session")
  const queue = controller.queue
  const [expanded, setExpanded] = React.useState(false)
  const [editing, setEditing] = React.useState<{ id: string; text: string } | null>(null)
  const items = queue?.items ?? []
  if (items.length === 0) return null
  const pause = queuePause(runtimeStatus, queue)
  const shown = expanded ? items : items.slice(0, COLLAPSED_ITEMS)
  const failure = t("queueActionFailed")

  const saveEdit = async () => {
    if (!editing) return
    const text = editing.text.trim()
    if (!text) return
    if (await controller.edit(editing.id, text, failure)) setEditing(null)
  }

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl rounded-xl border bg-muted/40 px-3 py-2 text-sm" data-testid="session-message-queue">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t("queueTitle", { count: items.length })}</span>
        {pause === "error" ? <span>{t("queuePausedError")}</span> : null}
        {pause === "failed" ? <span className="text-destructive">{t("queuePausedFailed")}</span> : null}
        <span className="flex-1" />
        {pause === "error" && canControl ? (
          <Button type="button" size="sm" variant="secondary" className="h-6 px-2 text-xs"
            disabled={controller.busyId !== null} onClick={() => void controller.resume(failure)}>
            {t("queueResume")}
          </Button>
        ) : null}
        {canControl && items.length > 1 ? (
          <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs"
            disabled={controller.busyId !== null} onClick={() => void controller.clear(failure)}>
            {t("queueClear")}
          </Button>
        ) : null}
      </div>
      <ul className="mt-1 space-y-1">
        {shown.map((item) => (
          <QueueRow
            key={item.messageId}
            item={item}
            busy={controller.busyId === item.messageId}
            editing={editing?.id === item.messageId ? editing.text : null}
            canControl={canControl}
            canInterrupt={canInterrupt}
            onEdit={(text) => setEditing({ id: item.messageId, text })}
            onCancelEdit={() => setEditing(null)}
            onSaveEdit={() => void saveEdit()}
            onDelete={() => void controller.remove(item.messageId, failure)}
            onRetry={() => void controller.retry(item.messageId, failure)}
            onSendNow={() => void controller.sendNow(item.messageId, failure)}
          />
        ))}
      </ul>
      {items.length > COLLAPSED_ITEMS ? (
        <button type="button" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          {expanded ? t("queueCollapse") : t("queueShowAll", { count: items.length })}
        </button>
      ) : null}
    </div>
  )
}

function QueueRow({
  item,
  busy,
  editing,
  canControl,
  canInterrupt,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onRetry,
  onSendNow,
}: {
  item: QueueItemView
  busy: boolean
  editing: string | null
  canControl: boolean
  canInterrupt: boolean
  onEdit: (text: string) => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onDelete: () => void
  onRetry: () => void
  onSendNow: () => void
}) {
  const t = useTranslations("dashboard.session")
  const editable = canControl && queueItemEditable(item)
  const failed = item.status === "failed"
  if (editing !== null) {
    return (
      <li className="flex items-start gap-1">
        <Textarea
          autoFocus
          value={editing}
          onChange={(event) => onEdit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSaveEdit() }
            if (event.key === "Escape") { event.preventDefault(); onCancelEdit() }
          }}
          className="min-h-8 flex-1 resize-none text-sm"
          aria-label={t("queueEdit")}
        />
        <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={t("queueSave")} disabled={busy || !editing.trim()} onClick={onSaveEdit}>
          <Check className="size-3.5" />
        </Button>
        <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={t("queueCancelEdit")} onClick={onCancelEdit}>
          <X className="size-3.5" />
        </Button>
      </li>
    )
  }
  return (
    <li className={cn("group flex items-center gap-2 rounded-md px-1 py-0.5", failed && "text-destructive")}>
      <span className="shrink-0 text-xs text-muted-foreground">
        {item.status === "sending" ? <Loader2 className="size-3 animate-spin" /> : failed ? <AlertCircle className="size-3" /> : `#${item.position}`}
      </span>
      <span
        className={cn("min-w-0 flex-1 truncate", editable && "cursor-text")}
        title={failed && item.error ? item.error.message : item.content}
        onClick={() => { if (editable) onEdit(item.content) }}
      >
        {item.content}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {item.status === "sending" ? t("queueSending") : failed ? t("queueFailed") : item.interruptRequested ? t("queueInterrupting") : t("queueWaiting")}
      </span>
      {editable ? (
        <span className="flex shrink-0 items-center opacity-70 group-hover:opacity-100">
          {busy ? <Loader2 className="mx-1.5 size-3.5 animate-spin" /> : null}
          {failed ? (
            <Button type="button" size="icon" variant="ghost" className="size-6" aria-label={t("queueRetry")} title={t("queueRetry")} disabled={busy} onClick={onRetry}>
              <RotateCw className="size-3.5" />
            </Button>
          ) : canInterrupt && !item.interruptRequested ? (
            <Button type="button" size="icon" variant="ghost" className="size-6" aria-label={t("queueSendNow")} title={t("queueSendNow")} disabled={busy} onClick={onSendNow}>
              <SendHorizontal className="size-3.5" />
            </Button>
          ) : null}
          <Button type="button" size="icon" variant="ghost" className="size-6" aria-label={t("queueEdit")} title={t("queueEdit")} disabled={busy} onClick={() => onEdit(item.content)}>
            <Pencil className="size-3.5" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="size-6" aria-label={t("queueDelete")} title={t("queueDelete")} disabled={busy} onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      ) : null}
    </li>
  )
}
