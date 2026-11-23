"use client"

import { Button } from "@/components/ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Progress } from "@/components/ui/progress"
import { formatTokens } from "@/components/conversation/text"
import type { Control } from "@/lib/types/v3"

export function ContextMeter({ usage }: { usage: Control["usage"] }) {
  if (!usage?.used || !usage.size) return null
  const percent = Math.min(100, Math.round((usage.used / usage.size) * 100))
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={10}
        closeDelay={100}
        render={<Button variant="outline" size="sm" className="tabular-nums" />}
      >
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.2}
            strokeWidth="2"
          />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - Math.max(percent, 2) / 100)}
          />
        </svg>
        {percent}%
      </HoverCardTrigger>
      <HoverCardContent align="end" className="flex w-64 flex-col gap-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">Context</span>
          <span className="text-muted-foreground tabular-nums">
            {formatTokens(usage.used)} / {formatTokens(usage.size)}
          </span>
        </div>
        <Progress value={percent} aria-label="Context usage" />
        {usage.model && <p className="text-xs text-muted-foreground">{usage.model}</p>}
      </HoverCardContent>
    </HoverCard>
  )
}
