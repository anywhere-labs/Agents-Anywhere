"use client"

// Messages waiting for the running turn to end (Control.queued), above the composer (v2 web-next
// session-message-queue): each can be sent now (steers it in), edited (v3 has no edit RPC: it is taken out of the
// queue and put back into the composer), or removed.
import { PencilIcon, SendIcon, XIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { QueuedMessage } from "@/lib/types/v3"

export function QueueRows({
  queued,
  canSteer,
  disabled,
  onSteer,
  onEdit,
  onRemove,
}: {
  queued: QueuedMessage[]
  canSteer: boolean
  disabled?: boolean
  onSteer: (q: QueuedMessage) => void
  onEdit: (q: QueuedMessage) => void
  onRemove: (q: QueuedMessage) => void
}) {
  const { t } = useI18n()
  if (!queued.length) return null
  const action = (label: string, onClick: () => void, icon: React.ReactNode) => (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick} />}
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
  return (
    <div className="mb-2 space-y-1 rounded-card bg-card p-2">
      <p className="px-2 pt-0.5 pb-1 text-xs text-muted-foreground">{t("conv.queueTitle")}</p>
      {queued.map((q) => (
        <div key={q.client_msg_id} className="flex items-center gap-2 rounded-full bg-background py-1 pr-1.5 pl-3.5">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {q.content || (q.attachments?.map((a) => a.name).join(", ") ?? "")}
          </span>
          {q.attachments?.length ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">+{q.attachments.length}</span>
          ) : null}
          <span className="flex shrink-0 items-center gap-0.5">
            {canSteer && action(t("conv.queueSteer"), () => onSteer(q), <SendIcon className="size-3" />)}
            {action(t("conv.queueEdit"), () => onEdit(q), <PencilIcon className="size-3" />)}
            {action(t("conv.queueRemove"), () => onRemove(q), <XIcon className="size-3.5" />)}
          </span>
        </div>
      ))}
    </div>
  )
}
