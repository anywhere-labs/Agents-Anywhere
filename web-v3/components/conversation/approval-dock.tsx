"use client"

// Waiting permission requests. They are answered inline, right under the tool call in the thread (Claude Code
// Desktop, Codex, Cursor: the Confirmation in steps.tsx). Above the composer there is only a slim reminder, shown
// while that inline card is scrolled out of view, with a button that brings it back. A request whose tool call is not
// in the loaded thread (an older page, or a request without one) cannot be answered inline: it gets the full card
// here, with the request's own options (reject on the left, the plain allow last and filled).
import { ArrowDownIcon, ShieldQuestionIcon } from "lucide-react"
import { useEffect, useState } from "react"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import type { Message, PendingRequest, ToolPart } from "@/lib/types/v3"

const ORDER = { reject_always: 0, reject_once: 1, allow_always: 2, allow_once: 3 } as const

function toolFor(messages: Message[], request: PendingRequest): ToolPart | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    const p = m.parts[0]
    if (p.type === "tool" && (p.id === request.tool_call_id || m.id === request.message_id)) return p
  }
  return undefined
}

const inlineCard = (requestId: string) =>
  document.querySelector<HTMLElement>(`[data-request-id="${CSS.escape(requestId)}"]`)

/** Whether the inline Confirmation for `requestId` is on screen (true until known otherwise). */
function useInlineCardVisible(requestId: string | null): boolean {
  const [state, setState] = useState<{ id: string | null; visible: boolean }>({ id: null, visible: true })
  useEffect(() => {
    if (!requestId) return
    let observer: IntersectionObserver | null = null
    let observed: Element | null = null
    // The turn may mount (or be swapped back in by the virtual list) after the request arrives: look again now and then.
    const attach = () => {
      const el = inlineCard(requestId)
      if (el === observed) return
      observer?.disconnect()
      observed = el
      if (!el) {
        setState({ id: requestId, visible: false })
        return
      }
      observer = new IntersectionObserver(([entry]) => setState({ id: requestId, visible: entry.isIntersecting }), {
        threshold: 0.6,
      })
      observer.observe(el)
    }
    const first = window.setTimeout(attach, 0)
    const poll = window.setInterval(attach, 800)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(poll)
      observer?.disconnect()
    }
  }, [requestId])
  return state.id === requestId ? state.visible : true
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
  const tool = request ? toolFor(messages, request) : undefined
  const inlineVisible = useInlineCardVisible(request && tool ? request.request_id : null)
  if (!request) return null

  if (tool) {
    if (inlineVisible) return null
    return (
      <div className="mb-2 flex items-center gap-2 rounded-full bg-surface-raised py-1 pr-1 pl-3.5 text-xs" aria-live="polite">
        <ShieldQuestionIcon className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate text-foreground">
          {t("conv.approvalTitle", { agent })}
          {pending.length > 1 && (
            <span className="text-muted-foreground"> · {t("conv.approvalMore", { count: pending.length - 1 })}</span>
          )}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 rounded-full px-2.5 text-xs"
          onClick={() => inlineCard(request.request_id)?.scrollIntoView({ block: "center", behavior: "smooth" })}
        >
          <ArrowDownIcon className="size-3.5" />
          {t("conv.approvalShow")}
        </Button>
      </div>
    )
  }

  const options = [...request.options].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
  return (
    <div className="relative mb-2">
      {pending.length > 1 && (
        <div aria-hidden className="absolute inset-x-4 -top-1.5 h-4 rounded-t-2xl bg-surface-raised/70" />
      )}
      <section aria-live="polite" className="relative space-y-3 rounded-card bg-surface-raised p-4 ring-1 ring-warning/25">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex shrink-0 text-warning [&_svg]:size-4">
            <ShieldQuestionIcon />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs text-muted-foreground">
              {t("conv.approvalTitle", { agent })}
              {pending.length > 1 && <span> · {t("conv.approvalMore", { count: pending.length - 1 })}</span>}
            </p>
            <p className="text-sm font-medium text-foreground">{request.title || t("conv.approvalAllow")}</p>
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
