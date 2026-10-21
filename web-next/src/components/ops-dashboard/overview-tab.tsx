"use client"

import { useTranslations } from "next-intl"

import { SERIES_COLORS, TrendLineChart } from "@/components/ops-dashboard/charts"
import { ChartCard, StatGrid, StatTile } from "@/components/ops-dashboard/stat-tile"
import type { UsageReportResponse } from "@/features/dashboard/types"
import {
  formatDurationMs,
  formatNumber,
  formatPercent,
} from "@/features/admin-usage/report-helpers"

export function OverviewTab({ report }: { report: UsageReportResponse }) {
  const t = useTranslations("pages.opsDashboard")
  const summary = report.summary
  const perUser = summary.activeUsers > 0 ? summary.messages / summary.activeUsers : null

  return (
    <div className="flex flex-col gap-6">
      <StatGrid>
        <StatTile
          label={t("metrics.activeUsers")}
          value={formatNumber(summary.activeUsers)}
          helper={t("metrics.avgDau", { value: summary.avgDau.toLocaleString() })}
        />
        <StatTile
          label={t("metrics.messages")}
          value={formatNumber(summary.messages)}
          helper={perUser === null ? null : t("metrics.messagesPerActiveUserHelper", { value: perUser.toFixed(1) })}
        />
        <StatTile
          label={t("metrics.activeSessions")}
          value={formatNumber(summary.sessions)}
          helper={summary.sessionsReadOnly > 0 ? t("metrics.readOnlySessionsHelper", { count: formatNumber(summary.sessionsReadOnly) }) : null}
        />
        <StatTile
          label={t("metrics.turns")}
          value={formatNumber(summary.turns)}
          helper={summary.turnFailureRate === null ? null : t("metrics.failureRateHelper", { value: formatPercent(summary.turnFailureRate) })}
        />
        <StatTile
          label={t("metrics.approvalsRequested")}
          value={formatNumber(summary.approvalsRequested)}
          helper={summary.approvalWaitMs.samples > 0 ? t("metrics.approvalWaitHelper", { value: formatDurationMs(summary.approvalWaitMs.p50) }) : null}
        />
        <StatTile
          label={t("metrics.connectorsOnline")}
          value={formatNumber(summary.connectorsOnline)}
          helper={t("metrics.ofTotal", { total: formatNumber(summary.totalConnectors) })}
        />
      </StatGrid>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title={t("charts.userTrend")}>
          <TrendLineChart
            data={report.daily}
            series={[
              { key: "activeUsers", label: t("series.activeUsers"), color: SERIES_COLORS[0] },
              { key: "newUsers", label: t("series.newUsers"), color: SERIES_COLORS[1] },
            ]}
          />
        </ChartCard>
        <ChartCard title={t("charts.volumeTrend")}>
          <TrendLineChart
            data={report.daily}
            series={[
              { key: "messages", label: t("series.messages"), color: SERIES_COLORS[0] },
              { key: "sessions", label: t("series.activeSessions"), color: SERIES_COLORS[1] },
              { key: "turns", label: t("series.turns"), color: SERIES_COLORS[2] },
            ]}
          />
        </ChartCard>
      </div>
    </div>
  )
}
