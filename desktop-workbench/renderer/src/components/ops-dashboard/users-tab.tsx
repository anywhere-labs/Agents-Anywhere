"use client"

import { useTranslations } from "next-intl"

import { BarsChart, SERIES_COLORS, TrendLineChart } from "@/components/ops-dashboard/charts"
import { ChartCard, EmptyNote, StatGrid, StatTile } from "@/components/ops-dashboard/stat-tile"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { UsageReportResponse } from "@/features/dashboard/types"
import {
  formatNumber,
  formatPercent,
  segmentRangeLabel,
} from "@/features/admin-usage/report-helpers"

export function UsersTab({ report }: { report: UsageReportResponse }) {
  const t = useTranslations("pages.opsDashboard")
  const summary = report.summary
  const histogram = report.users.messageHistogram.map((bucket) => ({ label: bucket.label, users: bucket.count }))

  return (
    <div className="flex flex-col gap-6">
      <StatGrid>
        <StatTile label={t("metrics.activeUsers")} value={formatNumber(summary.activeUsers)} />
        <StatTile label={t("metrics.newUsers")} value={formatNumber(summary.newUsers)} />
        <StatTile label={t("metrics.avgDauLabel")} value={summary.avgDau.toLocaleString()} />
        <StatTile label={t("metrics.wau")} value={formatNumber(summary.wau)} />
        <StatTile label={t("metrics.mau")} value={formatNumber(summary.mau)} />
        <StatTile label={t("metrics.totalUsers")} value={formatNumber(summary.totalUsers)} />
      </StatGrid>

      <ChartCard title={t("charts.rollingWindows")} hint={t("charts.rollingWindowsHint")}>
        <TrendLineChart
          data={report.daily}
          series={[
            { key: "activeUsers", label: t("series.activeUsers"), color: SERIES_COLORS[0] },
            { key: "wau", label: t("series.wau"), color: SERIES_COLORS[1] },
            { key: "mau", label: t("series.mau"), color: SERIES_COLORS[2] },
          ]}
        />
      </ChartCard>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title={t("segments.title")} hint={t("segments.hint")}>
          <StatGrid inset columns={3}>
            {report.users.segments.map((segment) => (
              <StatTile
                key={segment.segment}
                label={t(`segments.${segment.segment}`)}
                value={formatNumber(segment.count)}
                helper={t("segments.messagesRange", { range: segmentRangeLabel(segment.min, segment.max) })}
              />
            ))}
          </StatGrid>
        </ChartCard>
        <ChartCard title={t("charts.histogram")} hint={t("charts.histogramHint")}>
          <BarsChart
            data={histogram}
            xKey="label"
            tickFormatter={(value) => String(value)}
            series={[{ key: "users", label: t("series.users"), color: SERIES_COLORS[0] }]}
          />
        </ChartCard>
      </div>

      <ChartCard title={t("retention.title")} hint={t("retention.hint")}>
        {report.users.retention.length === 0 ? (
          <EmptyNote>{t("retention.empty")}</EmptyNote>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("retention.cohort")}</TableHead>
                <TableHead className="text-right">{t("retention.size")}</TableHead>
                <TableHead className="text-right">D1</TableHead>
                <TableHead className="text-right">D7</TableHead>
                <TableHead className="text-right">D30</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.users.retention.map((cohort) => (
                <TableRow key={cohort.cohortStart}>
                  <TableCell className="tabular-nums">
                    {cohort.cohortStart} – {cohort.cohortEnd}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(cohort.cohortSize)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(cohort.d1)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(cohort.d7)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(cohort.d30)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ChartCard>
    </div>
  )
}
