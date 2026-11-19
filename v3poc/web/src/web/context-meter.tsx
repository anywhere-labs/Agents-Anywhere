// AI Elements · Context (https://ui.shadcn.com/docs/ai-elements/base/context): how much of the context window the
// session uses, from `control.usage` (used / size). The pattern's Hover Card + Progress, with a small ring in the
// outline trigger instead of the bare "{percent}% context" text.
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type { Control } from '@protocol/timeline'
import { formatTokens } from '@/conversation/text'

export function ContextMeter({ usage }: { usage: Control['usage'] }) {
  if (!usage?.used || !usage.size) return null
  const percent = Math.min(100, Math.round((usage.used / usage.size) * 100))
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <HoverCard>
      <HoverCardTrigger delay={10} closeDelay={100} render={<Button variant="outline" size="sm" className="tabular-nums" />}>
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
          <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth="2" />
          <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(percent, 2) / 100)} />
        </svg>
        {percent}%
      </HoverCardTrigger>
      <HoverCardContent align="end" className="flex w-64 flex-col gap-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">上下文</span>
          <span className="text-muted-foreground tabular-nums">
            {formatTokens(usage.used)} / {formatTokens(usage.size)}
          </span>
        </div>
        <Progress value={percent} aria-label="上下文已用" />
        {usage.model && <p className="text-xs text-muted-foreground">模型：{usage.model}</p>}
      </HoverCardContent>
    </HoverCard>
  )
}
