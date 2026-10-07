"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

import {
  formatTokenCount,
  insightCacheHitPercent,
  insightContextPercent,
  insightDecodeTokensPerSecond,
  insightTotalTokens,
  readSessionInsights,
  type SessionInsights,
} from "@/features/dashboard/session-insights"
import type { SessionRuntimeState } from "@/features/dashboard/types"
import { cn } from "@/lib/utils"

/**
 * Conversation-total AI-call stats strip pinned to the bottom of the composer
 * (turns/steps, decode speed, cumulative tokens with cache hit, and context
 * occupancy). Renders nothing until the runtime reports at least one figure.
 */
export function SessionStatsBar({
  runtimeState,
  className,
}: {
  runtimeState?: SessionRuntimeState | null
  className?: string
}) {
  const t = useTranslations("dashboard.session")
  const insights = React.useMemo(
    () => readSessionInsights(runtimeState?.metadata),
    [runtimeState?.metadata],
  )
  if (!insights) return null

  const segments = buildSegments(insights, t)
  if (segments.length === 0) return null

  return (
    <div
      className={cn(
        "flex items-center gap-x-3 gap-y-0.5 overflow-x-auto px-3 pb-1.5 pt-0 text-[11px] leading-4 text-muted-foreground/75",
        className,
      )}
    >
      {segments.map((segment) => (
        <span
          key={segment.key}
          title={segment.title}
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap"
        >
          {segment.label}
        </span>
      ))}
    </div>
  )
}

type StatsSegment = { key: string; label: string; title?: string }

function buildSegments(
  insights: SessionInsights,
  t: ReturnType<typeof useTranslations<"dashboard.session">>,
): StatsSegment[] {
  const segments: StatsSegment[] = []
  const stats = insights.sessionStats
  if (stats?.turns) {
    const speed = insightDecodeTokensPerSecond(stats)
    segments.push({
      key: "turns",
      label: speed
        ? t("statsTurnsWithSpeed", {
            turns: stats.turns,
            steps: stats.steps ?? 0,
            speed: Math.round(speed),
          })
        : t("statsTurns", { turns: stats.turns, steps: stats.steps ?? 0 }),
      title: t("statsTurnsHint"),
    })
  }
  const usage = insights.tokenUsage
  if (usage) {
    const total = insightTotalTokens(usage)
    if (total > 0) {
      const cacheHit = insightCacheHitPercent(usage)
      segments.push({
        key: "tokens",
        label:
          cacheHit != null
            ? t("statsTokensWithCache", {
                tokens: formatTokenCount(total),
                percent: Math.round(cacheHit),
              })
            : t("statsTokens", { tokens: formatTokenCount(total) }),
        title: [
          `↑ ${formatTokenCount(
            (usage.uncachedInputTokens ?? 0) +
              (usage.cacheReadTokens ?? 0) +
              (usage.cacheWriteTokens ?? 0),
          )}`,
          `↓ ${formatTokenCount(usage.outputTokens ?? 0)}`,
        ].join(" · "),
      })
    }
  }
  const pressure = insights.contextPressure
  if (pressure) {
    const percent = insightContextPercent(pressure)
    if (percent != null) {
      segments.push({
        key: "context",
        label: t("statsContext", { percent: Math.round(percent) }),
        title: t("statsContextHint", {
          used: formatTokenCount(pressure.projectedTokens ?? pressure.pressureTokens ?? 0),
          window: formatTokenCount(pressure.contextWindow ?? 0),
        }),
      })
    }
  }
  return segments
}
