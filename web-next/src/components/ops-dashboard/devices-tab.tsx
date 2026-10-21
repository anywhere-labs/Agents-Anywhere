"use client"

import { useTranslations } from "next-intl"

import { SERIES_COLORS, TrendLineChart } from "@/components/ops-dashboard/charts"
import { ChartCard, EmptyNote, StatGrid, StatTile } from "@/components/ops-dashboard/stat-tile"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { UsageReportResponse } from "@/features/dashboard/types"
import { formatNumber } from "@/features/admin-usage/report-helpers"

const OS_LABELS: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
}

export function DevicesTab({ report }: { report: UsageReportResponse }) {
  const t = useTranslations("pages.opsDashboard")
  const devices = report.devices
  const summary = report.summary
  const asOf =
    devices.inventoryAsOf === "live"
      ? t("devices.asOfLive")
      : t("devices.asOfSnapshot", { date: devices.inventoryAsOf })

  return (
    <div className="flex flex-col gap-6">
      <StatGrid columns={4}>
        <StatTile label={t("metrics.totalConnectors")} value={formatNumber(devices.totalConnectors)} helper={asOf} />
        <StatTile label={t("metrics.connectorsSeen7d")} value={formatNumber(devices.connectorsSeen7d)} />
        <StatTile label={t("metrics.connectorsSeen30d")} value={formatNumber(devices.connectorsSeen30d)} />
        <StatTile label={t("metrics.connectorsOnline")} value={formatNumber(summary.connectorsOnline)} helper={t("metrics.connectorsOnlineHint")} />
      </StatGrid>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title={t("devices.byOs")}>
          {devices.byOs.length === 0 ? (
            <EmptyNote>{t("charts.empty")}</EmptyNote>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("devices.os")}</TableHead>
                  <TableHead className="text-right">{t("devices.connectors")}</TableHead>
                  <TableHead className="text-right">{t("devices.online")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.byOs.map((row) => (
                  <TableRow key={row.os}>
                    <TableCell>{OS_LABELS[row.os] ?? (row.os === "unknown" ? t("devices.unknownOs") : row.os)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.connectors)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.connectorsOnline)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ChartCard>

        <ChartCard title={t("devices.installs")} hint={t("devices.installsHint")}>
          {report.runtimes.length === 0 ? (
            <EmptyNote>{t("runtimes.empty")}</EmptyNote>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("runtimes.runtime")}</TableHead>
                  <TableHead className="text-right">{t("runtimes.discovered")}</TableHead>
                  <TableHead className="text-right">{t("runtimes.configured")}</TableHead>
                  <TableHead className="text-right">{t("runtimes.sessions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.runtimes.map((row) => (
                  <TableRow key={row.runtimeType}>
                    <TableCell className="font-medium">{row.displayName}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.discoveredConnectors)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.configuredConnectors)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.sessions)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ChartCard>
      </div>

      <ChartCard title={t("charts.inventory")} hint={t("charts.inventoryHint")}>
        {devices.inventoryDaily.length < 2 ? (
          <EmptyNote>{t("charts.inventoryEmpty")}</EmptyNote>
        ) : (
          <TrendLineChart
            data={devices.inventoryDaily}
            series={[
              { key: "users", label: t("series.usersTotal"), color: SERIES_COLORS[0] },
              { key: "connectors", label: t("series.connectors"), color: SERIES_COLORS[1] },
            ]}
          />
        )}
      </ChartCard>
    </div>
  )
}
