"use client"

import { useTranslations } from "next-intl"
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import { EmptyNote } from "@/components/ops-dashboard/stat-tile"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { formatCompactNumber, formatShortDate } from "@/features/admin-usage/report-helpers"
import { cn } from "@/lib/utils"

export type ChartSeries = {
  key: string
  label: string
  color: string
}

export type ChartDatum = Record<string, string | number | null>

// Fixed categorical order from the theme; a chart never seats more than three
// series so identity stays readable without relying on color alone.
export const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const

const GRID_STROKE = "var(--border)"

function chartConfig(series: ChartSeries[]): ChartConfig {
  return Object.fromEntries(series.map((item) => [item.key, { label: item.label, color: item.color }]))
}

// A range with nothing recorded shows one sentence in place of a flat line
// along zero, which otherwise reads as a chart of nothing.
function hasValues(data: ChartDatum[], series: ChartSeries[]): boolean {
  return data.some((row) => series.some((item) => {
    const value = row[item.key]
    return typeof value === "number" && value > 0
  }))
}

function axisTick(value: string | number) {
  return formatShortDate(value)
}

function valueTick(value: number) {
  return formatCompactNumber(value)
}

export function TrendLineChart({
  data,
  series,
  xKey = "date",
  className,
  tickFormatter = axisTick,
}: {
  data: ChartDatum[]
  series: ChartSeries[]
  xKey?: string
  className?: string
  tickFormatter?: (value: string | number) => string
}) {
  const t = useTranslations("pages.opsDashboard")
  if (!hasValues(data, series)) return <EmptyNote className={cn("h-64", className)}>{t("charts.empty")}</EmptyNote>
  return (
    <ChartContainer config={chartConfig(series)} className={cn("aspect-auto h-64 w-full", className)}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeOpacity={0.6} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} minTickGap={28} tickFormatter={tickFormatter} />
        <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tickFormatter={valueTick} />
        <ChartTooltip cursor={{ stroke: GRID_STROKE }} content={<ChartTooltipContent indicator="line" />} />
        {series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
        {series.map((item) => (
          <Line
            key={item.key}
            type="monotone"
            dataKey={item.key}
            stroke={`var(--color-${item.key})`}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)" }}
            isAnimationActive={false}
            connectNulls
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}

export function BarsChart({
  data,
  series,
  xKey = "date",
  stacked = false,
  className,
  tickFormatter = axisTick,
}: {
  data: ChartDatum[]
  series: ChartSeries[]
  xKey?: string
  stacked?: boolean
  className?: string
  tickFormatter?: (value: string | number) => string
}) {
  const t = useTranslations("pages.opsDashboard")
  if (!hasValues(data, series)) return <EmptyNote className={cn("h-64", className)}>{t("charts.empty")}</EmptyNote>
  return (
    <ChartContainer config={chartConfig(series)} className={cn("aspect-auto h-64 w-full", className)}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="30%">
        <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeOpacity={0.6} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} minTickGap={16} tickFormatter={tickFormatter} />
        <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tickFormatter={valueTick} />
        <ChartTooltip cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }} content={<ChartTooltipContent />} />
        {series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
        {series.map((item, index) => (
          <Bar
            key={item.key}
            dataKey={item.key}
            fill={`var(--color-${item.key})`}
            stackId={stacked ? "stack" : undefined}
            radius={!stacked || index === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
            maxBarSize={24}
            stroke="var(--background)"
            strokeWidth={stacked ? 2 : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}
