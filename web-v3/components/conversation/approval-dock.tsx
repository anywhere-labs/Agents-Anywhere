"use client"

// Waiting permission requests, above the composer and floating with it. The oldest is the card on top, saying all of
// what is asked (the whole command, or the tool's arguments), with the request's own options (reject on the left, the
// plain allow last and filled); the others are stacked behind it like cards, their edges showing above it. Answering
// the top one brings the next forward. The thread only marks the
// waiting tool call ("等待你确认", ThreadEnv `approvals: "host"`), as the mobile apps do with their native dock, so a
// request is answered in one place whether its tool call is on screen, scrolled away or on an older page.
import { ShieldQuestionIcon } from "lucide-react"
import { useState } from "react"

import { FLOATING_SURFACE } from "@/components/conversation/composer"
import { argumentsText, commandOf, cwdOf } from "@/components/conversation/text"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import type { Message, PendingRequest, ToolPart } from "@/lib/types/v3"
import { cn } from "@/lib/utils"

const ORDER = { reject_always: 0, reject_once: 1, allow_always: 2, allow_once: 3 } as const
/** Cards drawn behind the top one; more still count in its header. */
const MAX_BEHIND = 2
/** How far each card behind shows above the one in front of it (px). */
const PEEK = 8
/** Arguments longer than this (a whole file to write) are cut, and the card says so. */
const MAX_ARGUMENTS = 20_000
const CODE = "max-h-28 overflow-auto rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs break-all whitespace-pre-wrap text-foreground"

function toolFor(messages: Message[], request: PendingRequest): ToolPart | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    const p = m.parts[0]
    if (p.type === "tool" && (p.id === request.tool_call_id || m.id === request.message_id)) return p
  }
  return undefined
}

export function ApprovalDock({
  pending,
  messages,
  agent,
  disabled,
  onAnswer,
}: {
  pending: PendingRequest[]
  messages: Message[]
  agent: string
  disabled?: boolean
  onAnswer: (requestId: string, optionId: string) => Promise<void>
}) {
  const { t } = useI18n()
  const [answering, setAnswering] = useState<string | null>(null)
  const request = pending[0]
  if (!request) return null

  const tool = toolFor(messages, request)
  const command = tool?.kind === "execute" ? commandOf(tool) : undefined
  const cwd = tool ? cwdOf(tool) : undefined
  // A change that comes as a diff is in the thread, under the waiting call.
  const args = tool && !command && !tool.diffs?.length ? argumentsText(tool, request.title) : ""
  const options = [...request.options].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
  const behind = Math.min(pending.length - 1, MAX_BEHIND)

  return (
    <div className="relative mb-2" style={{ marginTop: behind * PEEK }}>
      {/* The cards behind: higher, narrower and closer to the page's colour the further back. Solid, like the one in
          front, so the messages under them do not show through their edges. */}
      {Array.from({ length: behind }, (_, i) => behind - i).map((depth) => (
        <div
          key={depth}
          aria-hidden
          className="absolute inset-0 origin-top rounded-card border border-input transition-transform duration-300 motion-reduce:transition-none"
          style={{
            transform: `translateY(${-depth * PEEK}px) scale(${1 - depth * 0.04})`,
            backgroundColor: `color-mix(in oklab, var(--card) ${100 - depth * 15}%, var(--background))`,
          }}
        />
      ))}
      <section
        key={request.request_id}
        aria-live="polite"
        className={cn(
          "relative space-y-3 rounded-card p-4 ring-1 ring-warning/30",
          FLOATING_SURFACE,
          // Solid, so the cards behind do not show through it.
          "bg-card dark:bg-card",
          "animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none"
        )}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex shrink-0 text-warning [&_svg]:size-4">
            <ShieldQuestionIcon />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="flex items-baseline gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{t("conv.approvalTitle", { agent })}</span>
              {pending.length > 1 && (
                <span className="shrink-0 tabular-nums">{t("conv.approvalMore", { count: pending.length - 1 })}</span>
              )}
            </p>
            {command ? (
              <>
                <p className="text-sm font-medium text-foreground">{t("conv.approvalRun")}</p>
                <pre className={CODE}>{command}</pre>
                {cwd && <p className="truncate text-xs text-muted-foreground">{t("conv.approvalIn", { cwd })}</p>}
              </>
            ) : (
              <>
                <p className="text-sm font-medium break-words text-foreground">{request.title || t("conv.approvalAllow")}</p>
                {args && <pre className={CODE}>{args.slice(0, MAX_ARGUMENTS)}</pre>}
                {args.length > MAX_ARGUMENTS && (
                  <p className="text-xs text-muted-foreground">{t("conv.approvalCut", { count: args.length - MAX_ARGUMENTS })}</p>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {options.map((o, i) => (
            <Button
              key={o.id}
              size="sm"
              variant={i === options.length - 1 ? "default" : "outline"}
              disabled={disabled || answering !== null}
              onClick={async () => {
                setAnswering(o.id)
                try {
                  await onAnswer(request.request_id, o.id)
                } finally {
                  setAnswering(null)
                }
              }}
            >
              {o.name}
            </Button>
          ))}
        </div>
      </section>
    </div>
  )
}
