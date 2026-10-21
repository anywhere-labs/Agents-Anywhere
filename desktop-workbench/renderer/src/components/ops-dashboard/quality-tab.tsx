"use client"

import { useTranslations } from "next-intl"

import { BarsChart, SERIES_COLORS, TrendLineChart } from "@/components/ops-dashboard/charts"
import { ChartCard, StatGrid, StatTile } from "@/components/ops-dashboard/stat-tile"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { UsageOutcomeRow, UsageReportResponse } from "@/features/dashboard/types"
import {
  formatDurationMs,
  formatNumber,
  formatPercent,
} from "@/features/admin-usage/report-helpers"

const OUTCOME_KEYS = new Set([
  "completed",
  "interrupted",
  "cancelled",
  "failed",
  "resolved",
  "closed",
  "expired",
  "unknown",
])

export function QualityTab({ report }: { report: UsageReportResponse }) {
  const t = useTranslations("pages.opsDashboard")
  const summary = report.summary
  const quality = report.quality
  const outcomesDaily = report.daily.map((point) => ({
    date: point.date,
    turnsOther: Math.max(0, point.turns - point.turnsFailed),
    turnsFailed: point.turnsFailed,
  }))
  const durationsDaily = report.daily.map((point) => ({
    date: point.date,
    p50: point.turnDurationP50Ms === null ? null : Math.round(point.turnDurationP50Ms / 100) / 10,
    p90: point.turnDurationP90Ms === null ? null : Math.round(point.turnDurationP90Ms / 100) / 10,
  }))
  const outcomeLabel = (outcome: string) =>
    OUTCOME_KEYS.has(outcome) ? t(`quality.outcomeLabels.${outcome}`) : outcome

  return (
    <div className="flex flex-col gap-6">
      <StatGrid columns={5}>
        <StatTile
          label={t("metrics.turnFailureRate")}
          value={formatPercent(summary.turnFailureRate)}
          helper={t("metrics.ofTurns", { count: formatNumber(summary.turns) })}
        />
        <StatTile
          label={t("metrics.turnDurationP50")}
          value={formatDurationMs(summary.turnDurationMs.p50)}
          helper={t("metrics.samples", { count: formatNumber(summary.turnDurationMs.samples) })}
        />
        <StatTile label={t("metrics.turnDurationP90")} value={formatDurationMs(summary.turnDurationMs.p90)} />
        <StatTile
          label={t("metrics.approvalWaitP50")}
          value={formatDurationMs(summary.approvalWaitMs.p50)}
          helper={t("metrics.samples", { count: formatNumber(summary.approvalWaitMs.samples) })}
        />
        <StatTile label={t("metrics.runtimeErrors")} value={formatNumber(summary.runtimeErrors)} />
      </StatGrid>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title={t("charts.turnOutcomesDaily")}>
          <BarsChart
            data={outcomesDaily}
            stacked
            series={[
              { key: "turnsOther", label: t("series.turnsOther"), color: SERIES_COLORS[0] },
              { key: "turnsFailed", label: t("series.turnsFailed"), color: SERIES_COLORS[3] },
            ]}
          />
        </ChartCard>
        <ChartCard title={t("charts.turnDurations")} hint={t("charts.turnDurationsHint")}>
          <TrendLineChart
            data={durationsDaily}
            series={[
              { key: "p50", label: t("series.p50"), color: SERIES_COLORS[0] },
              { key: "p90", label: t("series.p90"), color: SERIES_COLORS[2] },
            ]}
          />
        </ChartCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title={t("charts.approvalsDaily")}>
          <BarsChart
            data={report.daily}
            series={[
              { key: "approvalsRequested", label: t("series.approvalsRequested"), color: SERIES_COLORS[0] },
              { key: "approvalsResolved", label: t("series.approvalsResolved"), color: SERIES_COLORS[1] },
            ]}
          />
        </ChartCard>
        <div className="grid gap-6 sm:grid-cols-2">
          <OutcomeTable title={t("quality.outcomes")} rows={quality.turnOutcomes} label={outcomeLabel} />
          <OutcomeTable title={t("quality.approvalOutcomes")} rows={quality.approvalOutcomes} label={outcomeLabel} />
        </div>
      </div>
    </div>
  )
}

function OutcomeTable({
  title,
  rows,
  label,
}: {
  title: string
  rows: UsageOutcomeRow[]
  label: (outcome: string) => string
}) {
  const t = useTranslations("pages.opsDashboard")
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  return (
    <ChartCard title={title}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("quality.outcome")}</TableHead>
            <TableHead className="text-right">{t("quality.count")}</TableHead>
            <TableHead className="text-right">{t("quality.share")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.outcome}>
              <TableCell>{label(row.outcome)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(row.count)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {total > 0 ? formatPercent(row.count / total) : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ChartCard>
  )
}
