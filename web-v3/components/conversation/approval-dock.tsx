"use client"

// Waiting permission requests, docked above the composer (client-experience-proposal §2.4: "固定在输入框上方的审批区，不混在
// 消息流里滚走"; v2 web-next's session-blocking dock): the first request is active with the request's own options
// (reject on the left, the plain allow last and filled), the others stack behind it as "N more waiting". The thread
// still marks the step that waits.
import { ShieldQuestionIcon, TerminalIcon } from "lucide-react"
import { useState } from "react"

import { commandOf, cwdOf } from "@/components/conversation/text"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import type { Message, PendingRequest, ToolPart } from "@/lib/types/v3"
import { tildePath } from "@/lib/workbench/tree"

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
  const options = [...request.options].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
  return (
    <div className="relative mb-2">
      {pending.length > 1 && (
        <div aria-hidden className="absolute inset-x-4 -top-1.5 h-4 rounded-t-2xl bg-surface-raised/70" />
      )}
      <section
        aria-live="polite"
        className="relative space-y-3 rounded-card bg-surface-raised p-4 ring-1 ring-warning/25"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex shrink-0 text-warning [&_svg]:size-4">
            {command ? <TerminalIcon /> : <ShieldQuestionIcon />}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs text-muted-foreground">
              {t("conv.approvalTitle", { agent })}
              {pending.length > 1 && <span> · {t("conv.approvalMore", { count: pending.length - 1 })}</span>}
            </p>
            <p className="text-sm font-medium text-foreground">
              {command ? t("conv.approvalRun") : request.title || t("conv.approvalAllow")}
            </p>
            {command && (
              <pre className="max-h-32 overflow-auto rounded-xl bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all text-foreground">
                $ {command}
              </pre>
            )}
            {cwd && <p className="text-[11px] text-muted-foreground">{t("conv.approvalIn", { cwd: tildePath(cwd) })}</p>}
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
