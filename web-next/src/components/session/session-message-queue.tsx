"use client"

import {
  Copy,
  CornerDownRight,
  Ellipsis,
  ListRestart,
  Loader2,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { QueuedSessionMessage } from "@/features/dashboard/types"

export type SessionQueueAction = "cancel" | "promote" | "retry" | "steer"

export function SessionMessageQueue({
  items,
  canSteer,
  busyAction,
  onCancel,
  onPromote,
  onRetry,
  onSteer,
}: {
  items: QueuedSessionMessage[]
  canSteer: boolean
  busyAction: { messageId: string; action: SessionQueueAction } | null
  onCancel: (messageId: string) => void
  onPromote: (messageId: string) => void
  onRetry: (messageId: string) => void
  onSteer: (messageId: string) => void
}) {
  const t = useTranslations("dashboard.session")
  if (items.length === 0) return null

  return (
    <div className="relative z-0 mx-auto -mb-7 w-full max-w-3xl px-7">
      <div className="rounded-[1.75rem] border border-border/80 bg-card/95 px-3 pb-8 pt-3 shadow-sm backdrop-blur-xl supports-backdrop-filter:bg-card/90">
        <TooltipProvider delayDuration={300}>
          <ItemGroup className="gap-0">
            {items.map((item) => {
              const isDispatching = item.status === "dispatching"
              const itemBusy = busyAction?.messageId === item.id
              const canAct = !isDispatching && !itemBusy
              const errorMessage = queueErrorMessage(item)
              return (
                <Item
                  key={item.id}
                  size="sm"
                  className={cn(
                    "min-h-11 flex-nowrap gap-2 rounded-xl border-0 px-2 py-1.5",
                    item.status === "failed" && "bg-destructive/5",
                  )}
                >
                  <ItemMedia variant="icon" className="text-muted-foreground">
                    {isDispatching || itemBusy ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : (
                      <ListRestart aria-hidden="true" />
                    )}
                  </ItemMedia>
                  <ItemContent className="min-w-0 gap-0">
                    <ItemTitle className="block w-full truncate text-base font-normal">
                      {item.content || t("queueAttachmentOnly")}
                    </ItemTitle>
                    {errorMessage ? (
                      <ItemDescription className="line-clamp-1 text-xs text-destructive">
                        {errorMessage}
                      </ItemDescription>
                    ) : null}
                  </ItemContent>
                  <ItemActions className="shrink-0 gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="hidden h-8 rounded-xl px-2.5 text-muted-foreground sm:inline-flex"
                      disabled={!canAct || !canSteer}
                      title={!canSteer ? t("queueSteerUnavailable") : undefined}
                      onClick={() => onSteer(item.id)}
                    >
                      <CornerDownRight data-icon="inline-start" />
                      {t("queueSteer")}
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8 rounded-xl text-muted-foreground"
                            disabled={!canAct}
                            aria-label={t("queueRemove")}
                            onClick={() => onCancel(item.id)}
                          >
                            <Trash2 data-icon="icon" />
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top">{t("queueRemove")}</TooltipContent>
                    </Tooltip>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 rounded-xl text-muted-foreground"
                          disabled={!canAct}
                          aria-label={t("queueMore")}
                        >
                          <Ellipsis data-icon="icon" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuGroup>
                          <DropdownMenuItem onSelect={() => onPromote(item.id)}>
                            <Undo2 />
                            {t("queueMoveFirst")}
                          </DropdownMenuItem>
                          {item.status === "failed" ? (
                            <DropdownMenuItem onSelect={() => onRetry(item.id)}>
                              <RotateCcw />
                              {t("queueRetry")}
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem
                            className="sm:hidden"
                            disabled={!canSteer}
                            onSelect={() => onSteer(item.id)}
                          >
                            <CornerDownRight />
                            {t("queueSteer")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              void navigator.clipboard.writeText(item.content).then(
                                () => toast.success(t("queueCopied")),
                                () => toast.error(t("queueCopyFailed")),
                              )
                            }}
                          >
                            <Copy />
                            {t("queueCopy")}
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
        </TooltipProvider>
      </div>
    </div>
  )
}

function queueErrorMessage(item: QueuedSessionMessage): string | null {
  const message = item.lastError?.message
  return typeof message === "string" && message ? message : null
}
