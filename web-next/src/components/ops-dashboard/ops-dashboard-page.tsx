"use client"

import * as React from "react"
import { RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { useAuth } from "@/components/auth/auth-context"
import { DevicesTab } from "@/components/ops-dashboard/devices-tab"
import { OverviewTab } from "@/components/ops-dashboard/overview-tab"
import { QualityTab } from "@/components/ops-dashboard/quality-tab"
import { UsageTab } from "@/components/ops-dashboard/usage-tab"
import { UsersTab } from "@/components/ops-dashboard/users-tab"
import { PageHeader } from "@/components/pages/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { dashboardApi } from "@/features/dashboard/api"
import type { UsageLiveResponse, UsageReportResponse } from "@/features/dashboard/types"
import {
  browserTimeZone,
  clampRange,
  formatNumber,
  localToday,
  presetRange,
  type UsageDateRange,
  type UsageRangePreset,
} from "@/features/admin-usage/report-helpers"
import { cn } from "@/lib/utils"

export type DashboardTab = "overview" | "users" | "usage" | "devices" | "quality"

const PRESETS: UsageRangePreset[] = ["7d", "30d", "90d", "custom"]
const LIVE_REFRESH_MS = 30_000

/** The usage board; `tab` comes from the administration route (`#/admin/<tab>`). */
export function OpsDashboardPage({ tab }: { tab: DashboardTab }) {
  const { session } = useAuth()
  const t = useTranslations("pages.opsDashboard")
  const token = session?.accessToken
  const timeZone = React.useMemo(() => browserTimeZone(), [])

  const [preset, setPreset] = React.useState<UsageRangePreset>("30d")
  const [range, setRange] = React.useState<UsageDateRange>(() => presetRange("30d", localToday(timeZone)))
  const [draft, setDraft] = React.useState<UsageDateRange>(range)
  const [draftError, setDraftError] = React.useState(false)
  const [report, setReport] = React.useState<UsageReportResponse | null>(null)
  const [live, setLive] = React.useState<UsageLiveResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadKey, setReloadKey] = React.useState(0)

  React.useEffect(() => {
    if (!token) return
    let cancelled = false
    setLoading(true)
    setError(null)
    dashboardApi
      .getAdminUsageReport(token, { from: range.from, to: range.to, tz: timeZone })
      .then((data) => {
        if (cancelled) return
        setReport(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t("loadFailed"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [range.from, range.to, reloadKey, t, timeZone, token])

  React.useEffect(() => {
    if (!token) return
    let cancelled = false
    const poll = async () => {
      try {
        const data = await dashboardApi.getAdminUsageLive(token)
        if (!cancelled) setLive(data)
      } catch {
        // The live strip is best-effort; the report carries the real numbers.
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), LIVE_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [reloadKey, token])

  const choosePreset = (next: UsageRangePreset) => {
    setPreset(next)
    if (next === "custom") {
      setDraft(range)
      setDraftError(false)
      return
    }
    setRange(presetRange(next, localToday(timeZone)))
  }

  const applyDraft = () => {
    const next = clampRange(draft)
    if (!next) {
      setDraftError(true)
      return
    }
    setDraftError(false)
    setRange(next)
  }

  const refresh = () => setReloadKey((value) => value + 1)
  const dataSince = report?.range.dataSince ?? null

  return (
    <ScrollArea className="@container/page h-full w-full bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 pb-16 pt-14 @min-[68rem]/page:pt-8">
        <PageHeader title={t(`tabs.${tab}`)} description={t("description")}>
          <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCw data-icon="inline-start" />}
            {t("refresh")}
          </Button>
        </PageHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* The joined preset group does not wrap; on narrow screens it scrolls instead of overflowing. */}
            <div className="no-scrollbar max-w-full overflow-x-auto">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={preset}
                onValueChange={(value) => {
                  if (value) choosePreset(value as UsageRangePreset)
                }}
              >
                {PRESETS.map((item) => (
                  <ToggleGroupItem key={item} value={item} aria-label={t(`range.${item}`)}>
                    {t(`range.${item}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            {preset === "custom" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  aria-label={t("range.from")}
                  value={draft.from}
                  max={draft.to}
                  onChange={(event) => setDraft((current) => ({ ...current, from: event.currentTarget.value }))}
                  className={cn("h-8 w-36", draftError && "border-destructive")}
                />
                <span className="text-xs text-muted-foreground">–</span>
                <Input
                  type="date"
                  aria-label={t("range.to")}
                  value={draft.to}
                  min={draft.from}
                  onChange={(event) => setDraft((current) => ({ ...current, to: event.currentTarget.value }))}
                  className={cn("h-8 w-36", draftError && "border-destructive")}
                />
                <Button type="button" size="sm" onClick={applyDraft}>
                  {t("range.apply")}
                </Button>
                {draftError ? <span className="text-xs text-destructive">{t("range.invalid")}</span> : null}
              </div>
            ) : (
              <span className="text-sm tabular-nums text-muted-foreground">
                {range.from} – {range.to}
              </span>
            )}
            <span className="text-xs text-muted-foreground">{timeZone}</span>
          </div>
          <LiveStrip
            live={live}
            note={dataSince ? t("dataSince", { date: dataSince }) : report ? t("noDataYet") : null}
          />
        </div>

        {error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4 text-sm text-destructive">
            <span>{error}</span>
            <Button type="button" variant="outline" size="sm" onClick={refresh}>
              {t("retry")}
            </Button>
          </div>
        ) : report ? (
          <div className={cn("transition-opacity", loading && "pointer-events-none opacity-60")}>
            <DashboardContent tab={tab} report={report} />
          </div>
        ) : (
          <ReportSkeleton />
        )}
      </div>
    </ScrollArea>
  )
}

function DashboardContent({ tab, report }: { tab: DashboardTab; report: UsageReportResponse }) {
  if (tab === "users") return <UsersTab report={report} />
  if (tab === "usage") return <UsageTab report={report} />
  if (tab === "devices") return <DevicesTab report={report} />
  if (tab === "quality") return <QualityTab report={report} />
  return <OverviewTab report={report} />
}

function LiveStrip({ live, note }: { live: UsageLiveResponse | null; note: string | null }) {
  const t = useTranslations("pages.opsDashboard")
  const items: { key: string; value: string }[] = [
    {
      key: "onlineConnectors",
      value: live ? `${formatNumber(live.onlineConnectors)} / ${formatNumber(live.totalConnectors)}` : "—",
    },
    { key: "runningTurns", value: live ? formatNumber(live.runningTurns) : "—" },
    { key: "activeUsers15m", value: live ? formatNumber(live.activeUsers15m) : "—" },
  ]
  // Live figures stay a line of text: they are current state, not part of the
  // selected range, so they must not look like another row of the report.
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
      <span className="flex items-center gap-2 font-medium">
        <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
        {t("live.title")}
      </span>
      {items.map((item) => (
        <span key={item.key} className="flex items-baseline gap-1.5">
          <span className="text-muted-foreground">{t(`live.${item.key}`)}</span>
          <span className="font-medium tabular-nums">{item.value}</span>
        </span>
      ))}
      {note ? <span className="text-xs text-muted-foreground sm:ml-auto">{note}</span> : null}
    </div>
  )
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-24 rounded-[24px]" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Skeleton className="h-80 rounded-[24px]" />
        <Skeleton className="h-80 rounded-[24px]" />
      </div>
    </div>
  )
}
