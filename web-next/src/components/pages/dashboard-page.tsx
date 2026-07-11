"use client"

import * as React from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts"
import {
  ChevronLeft,
  Gauge,
  Laptop,
  LineChart,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Users,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-context"
import { LoadingState } from "@/components/loading-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useWorkspace } from "@/components/workspace-context"
import { dashboardApi } from "@/features/dashboard/api"
import type {
  AdminDashboardBreakdownItem,
  AdminDashboardOverviewResponse,
  AdminDashboardSettings,
} from "@/features/dashboard/types"
import { cn } from "@/lib/utils"

type DashboardTab = "overview" | "usage" | "users" | "devices" | "agents"

const DEFAULT_TZ = "Asia/Shanghai"
const CHART_COLORS = ["#60a5fa", "#34d399", "#f59e0b", "#f87171", "#a78bfa"]
const TREND_COLORS = {
  dau: "#60a5fa",
  activeUsers: "#a78bfa",
  newUsers: "#f87171",
  totalTurns: "#34d399",
  activeSessions: "#f59e0b",
} as const

const trendConfig = {
  dau: { label: "DAU", color: TREND_COLORS.dau },
  activeUsers: { label: "Active users", color: TREND_COLORS.activeUsers },
  newUsers: { label: "New users", color: TREND_COLORS.newUsers },
  totalTurns: { label: "Turns", color: TREND_COLORS.totalTurns },
  activeSessions: { label: "Sessions", color: TREND_COLORS.activeSessions },
} satisfies ChartConfig

const distributionConfig = {
  count: { label: "Users", color: "var(--chart-1)" },
} satisfies ChartConfig

const navItems: { id: DashboardTab; icon: typeof LineChart; labelKey: string }[] = [
  { id: "overview", icon: LineChart, labelKey: "overview" },
  { id: "usage", icon: Gauge, labelKey: "usage" },
  { id: "users", icon: Users, labelKey: "users" },
  { id: "devices", icon: Laptop, labelKey: "devices" },
  { id: "agents", icon: SlidersHorizontal, labelKey: "agents" },
]

export function DashboardPage() {
  const { navigate } = useWorkspace()
  const { session } = useAuth()
  const t = useTranslations("pages.opsDashboard")
  const tCommon = useTranslations("common")
  const [tab, setTab] = React.useState<DashboardTab>("overview")
  const [toDate, setToDate] = React.useState(todayDate)
  const [fromDate, setFromDate] = React.useState(() => shiftDate(todayDate(), -29))
  const [overview, setOverview] = React.useState<AdminDashboardOverviewResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [settingsDraft, setSettingsDraft] = React.useState<AdminDashboardSettings | null>(null)
  const [savingSettings, setSavingSettings] = React.useState(false)
  const token = session?.accessToken

  const load = React.useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const data = await dashboardApi.getAdminDashboardOverview(token, {
        from: fromDate,
        to: toDate,
        tz: DEFAULT_TZ,
      })
      setOverview(data)
      setSettingsDraft(data.settings)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [fromDate, t, toDate, token])

  React.useEffect(() => {
    void load()
  }, [load])

  const refreshToday = async () => {
    if (!token || refreshing) return
    setRefreshing(true)
    try {
      await dashboardApi.refreshAdminDashboardToday(token, DEFAULT_TZ)
      await load()
      toast.success(t("refreshSaved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("refreshFailed"))
      setRefreshing(false)
    }
  }

  const saveSettings = async () => {
    if (!token || !settingsDraft || savingSettings) return
    setSavingSettings(true)
    try {
      await dashboardApi.updateAdminDashboardSettings(token, {
        intensity: settingsDraft.intensity,
        histogramBins: settingsDraft.histogramBins,
      })
      await load()
      toast.success(t("settingsSaved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settingsFailed"))
    } finally {
      setSavingSettings(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="px-8 pb-0 pt-8">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("home")}
          className="mb-6 -ml-2 gap-1.5 text-muted-foreground"
        >
          <ChevronLeft className="size-4" />
          {tCommon("back")}
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">{t("title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <DateField label={t("from")} value={fromDate} onChange={setFromDate} />
            <DateField label={t("to")} value={toDate} onChange={setToDate} />
            <Button type="button" variant="outline" onClick={() => void load()}>
              <RefreshCw data-icon="inline-start" />
              {t("load")}
            </Button>
            <Button type="button" onClick={() => void refreshToday()} disabled={refreshing}>
              {refreshing ? <Spinner /> : <RefreshCw data-icon="inline-start" />}
              {t("refreshToday")}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-8 overflow-hidden px-8 py-8">
        <nav className="flex w-52 shrink-0 flex-col gap-0.5">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                  tab === item.id
                    ? "bg-sidebar-accent text-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {t(`tabs.${item.labelKey}`)}
              </button>
            )
          })}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto pr-2">
          {loading ? (
            <LoadingState className="min-h-96 rounded-xl border border-border bg-card" />
          ) : error ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4 text-sm text-destructive">
              {error}
            </div>
          ) : overview ? (
            <DashboardContent
              tab={tab}
              overview={overview}
              settingsDraft={settingsDraft}
              savingSettings={savingSettings}
              onSettingsChange={setSettingsDraft}
              onSaveSettings={saveSettings}
            />
          ) : null}
        </main>
      </div>
    </div>
  )
}

function DashboardContent({
  tab,
  overview,
  settingsDraft,
  savingSettings,
  onSettingsChange,
  onSaveSettings,
}: {
  tab: DashboardTab
  overview: AdminDashboardOverviewResponse
  settingsDraft: AdminDashboardSettings | null
  savingSettings: boolean
  onSettingsChange: (settings: AdminDashboardSettings) => void
  onSaveSettings: () => void
}) {
  if (tab === "usage") {
    return (
      <UsageTab
        overview={overview}
        settingsDraft={settingsDraft}
        savingSettings={savingSettings}
        onSettingsChange={onSettingsChange}
        onSaveSettings={onSaveSettings}
      />
    )
  }
  if (tab === "users") return <UsersTab overview={overview} />
  if (tab === "devices") return <DevicesTab overview={overview} />
  if (tab === "agents") return <AgentsTab overview={overview} />
  return <OverviewTab overview={overview} />
}

function OverviewTab({ overview }: { overview: AdminDashboardOverviewResponse }) {
  const t = useTranslations("pages.opsDashboard")
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={t("metrics.dau")}
          value={overview.summary.dau}
          helper={t("metrics.userShare", { percent: userShare(overview.summary.dau, overview.summary.totalUsers) })}
        />
        <MetricCard
          label={t("metrics.activeUsers")}
          value={overview.summary.activeUsers}
          helper={t("metrics.userShare", {
            percent: userShare(overview.summary.activeUsers, overview.summary.totalUsers),
          })}
        />
        <MetricCard label={t("metrics.turns")} value={overview.summary.totalTurns} />
        <MetricCard label={t("metrics.activeSessions")} value={overview.summary.activeSessions} />
      </div>
      <section className="rounded-xl border border-border bg-card">
        <div className="px-5 py-4">
          <h2 className="text-base font-semibold">{t("trend")}</h2>
        </div>
        <Separator />
        <div className="p-5">
          <TrendChart data={overview.series} />
        </div>
      </section>
    </div>
  )
}

function UsageTab({
  overview,
  settingsDraft,
  savingSettings,
  onSettingsChange,
  onSaveSettings,
}: {
  overview: AdminDashboardOverviewResponse
  settingsDraft: AdminDashboardSettings | null
  savingSettings: boolean
  onSettingsChange: (settings: AdminDashboardSettings) => void
  onSaveSettings: () => void
}) {
  const t = useTranslations("pages.opsDashboard")
  if (!settingsDraft) return null
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <HistogramPanel
          title={t("turnHistogram")}
          data={overview.turnHistogram}
          axisDescription={t("axes.turnHistogram")}
        />
        <HistogramPanel
          title={t("sessionHistogram")}
          data={overview.sessionHistogram}
          axisDescription={t("axes.sessionHistogram")}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <SegmentPanel items={overview.userSegments} totalUsers={overview.summary.totalUsers} />
        <section className="rounded-xl border border-border bg-card">
          <div className="px-5 py-4">
            <h2 className="text-base font-semibold">{t("sessionAgentBreakdown")}</h2>
          </div>
          <Separator />
          <BreakdownTable items={overview.sessionAgentBreakdown} />
        </section>
      </div>
      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{t("intensitySettings")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t("intensityDescription")}</p>
          </div>
          <Button type="button" size="sm" onClick={onSaveSettings} disabled={savingSettings}>
            {savingSettings ? <Spinner /> : <Save data-icon="inline-start" />}
            {t("saveSettings")}
          </Button>
        </div>
        <Separator />
        <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-4">
          <NumberField
            label={t("lightMax")}
            value={settingsDraft.intensity.lightMax}
            onChange={(value) =>
              onSettingsChange({
                ...settingsDraft,
                intensity: { ...settingsDraft.intensity, lightMax: value },
              })
            }
          />
          <NumberField
            label={t("mediumMax")}
            value={settingsDraft.intensity.mediumMax}
            onChange={(value) =>
              onSettingsChange({
                ...settingsDraft,
                intensity: { ...settingsDraft.intensity, mediumMax: value },
              })
            }
          />
          <ListField
            label={t("turnBins")}
            value={settingsDraft.histogramBins.turns}
            onChange={(value) =>
              onSettingsChange({
                ...settingsDraft,
                histogramBins: { ...settingsDraft.histogramBins, turns: value },
              })
            }
          />
          <ListField
            label={t("sessionBins")}
            value={settingsDraft.histogramBins.sessions}
            onChange={(value) =>
              onSettingsChange({
                ...settingsDraft,
                histogramBins: { ...settingsDraft.histogramBins, sessions: value },
              })
            }
          />
        </div>
      </section>
    </div>
  )
}

function UsersTab({ overview }: { overview: AdminDashboardOverviewResponse }) {
  const t = useTranslations("pages.opsDashboard")
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard label={t("metrics.totalUsers")} value={overview.summary.totalUsers} />
        <MetricCard
          label={t("metrics.dau")}
          value={overview.summary.dau}
          helper={t("metrics.userShare", { percent: userShare(overview.summary.dau, overview.summary.totalUsers) })}
        />
        <MetricCard
          label={t("metrics.activeUsers")}
          value={overview.summary.activeUsers}
          helper={t("metrics.userShare", {
            percent: userShare(overview.summary.activeUsers, overview.summary.totalUsers),
          })}
        />
        <MetricCard label={t("metrics.newUsers")} value={overview.summary.newUsers} />
        <MetricCard label={t("metrics.mau")} value={overview.summary.mau} />
      </div>
      <section className="rounded-xl border border-border bg-card">
        <div className="px-5 py-4">
          <h2 className="text-base font-semibold">{t("userTrend")}</h2>
        </div>
        <Separator />
        <div className="p-5">
          <UserTrendChart data={overview.series} />
        </div>
      </section>
    </div>
  )
}

function DevicesTab({ overview }: { overview: AdminDashboardOverviewResponse }) {
  const t = useTranslations("pages.opsDashboard")
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={t("metrics.avgDevices")} value={overview.summary.avgDevicesPerUser.toFixed(2)} />
        <MetricCard label={t("metrics.totalDevices")} value={overview.summary.totalDevices} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <BreakdownPie title={t("tabs.devices")} items={overview.deviceBreakdown} />
        <BreakdownPanel title={t("breakdown")} items={overview.deviceBreakdown} />
      </div>
    </div>
  )
}

function AgentsTab({ overview }: { overview: AdminDashboardOverviewResponse }) {
  const t = useTranslations("pages.opsDashboard")
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <BreakdownPie title={t("agentBreakdown")} items={overview.agentBreakdown} />
      <BreakdownPie title={t("sessionAgentBreakdown")} items={overview.sessionAgentBreakdown} />
      <BreakdownPanel title={t("agentBreakdown")} items={overview.agentBreakdown} />
      <BreakdownPanel title={t("sessionAgentBreakdown")} items={overview.sessionAgentBreakdown} />
    </div>
  )
}

function MetricCard({ label, value, helper }: { label: string; value: string | number; helper?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{formatValue(value)}</div>
        {helper ? <p className="mt-1 text-xs text-muted-foreground">{helper}</p> : null}
      </CardContent>
    </Card>
  )
}

function UserTrendChart({ data }: { data: AdminDashboardOverviewResponse["series"] }) {
  return (
    <ChartContainer config={trendConfig} className="h-[300px] w-full">
      <AreaChart data={data} margin={{ left: 8, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={42} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area type="monotone" dataKey="dau" stroke={TREND_COLORS.dau} strokeWidth={2} fill={TREND_COLORS.dau} fillOpacity={0.12} />
        <Area type="monotone" dataKey="activeUsers" stroke={TREND_COLORS.activeUsers} strokeWidth={2} fill={TREND_COLORS.activeUsers} fillOpacity={0.1} />
        <Area type="monotone" dataKey="newUsers" stroke={TREND_COLORS.newUsers} strokeWidth={2} fill={TREND_COLORS.newUsers} fillOpacity={0.08} />
      </AreaChart>
    </ChartContainer>
  )
}

function TrendChart({ data }: { data: AdminDashboardOverviewResponse["series"] }) {
  return (
    <ChartContainer config={trendConfig} className="h-[320px] w-full">
      <AreaChart data={data} margin={{ left: 8, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={42} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area type="monotone" dataKey="dau" stroke={TREND_COLORS.dau} strokeWidth={2} fill={TREND_COLORS.dau} fillOpacity={0.12} />
        <Area type="monotone" dataKey="activeUsers" stroke={TREND_COLORS.activeUsers} strokeWidth={2} fill={TREND_COLORS.activeUsers} fillOpacity={0.1} />
        <Area type="monotone" dataKey="totalTurns" stroke={TREND_COLORS.totalTurns} strokeWidth={2} fill={TREND_COLORS.totalTurns} fillOpacity={0.1} />
        <Area type="monotone" dataKey="activeSessions" stroke={TREND_COLORS.activeSessions} strokeWidth={2} fill={TREND_COLORS.activeSessions} fillOpacity={0.08} />
      </AreaChart>
    </ChartContainer>
  )
}

function HistogramPanel({
  title,
  data,
  axisDescription,
}: {
  title: string
  data: Array<{ label: string; count: number }>
  axisDescription: string
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="px-5 py-4">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{axisDescription}</p>
      </div>
      <Separator />
      <div className="p-5">
        <ChartContainer config={distributionConfig} className="h-[240px] w-full">
          <BarChart data={data} margin={{ left: 8, right: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} width={36} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="count" fill="var(--color-count)" radius={4} />
          </BarChart>
        </ChartContainer>
      </div>
    </section>
  )
}

function SegmentPanel({
  items,
  totalUsers,
}: {
  items: AdminDashboardOverviewResponse["userSegments"]
  totalUsers: number
}) {
  const t = useTranslations("pages.opsDashboard")
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="px-5 py-4">
        <h2 className="text-base font-semibold">{t("userSegments")}</h2>
      </div>
      <Separator />
      <div className="grid gap-3 p-5 md:grid-cols-3">
        {items.map((item) => (
          <div key={item.segment} className="rounded-lg border border-border px-4 py-3">
            <p className="text-sm text-muted-foreground">{t(`segments.${item.segment}`)}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{item.count.toLocaleString()}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("segments.userShare", { percent: userShare(item.count, totalUsers) })}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}

function BreakdownPanel({ title, items }: { title: string; items: AdminDashboardBreakdownItem[] }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="px-5 py-4">
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      <Separator />
      <BreakdownTable items={items} />
    </section>
  )
}

function BreakdownTable({ items }: { items: AdminDashboardBreakdownItem[] }) {
  const t = useTranslations("pages.opsDashboard")
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("name")}</TableHead>
          <TableHead className="text-right">{t("value")}</TableHead>
          <TableHead className="text-right">{t("percent")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.key}>
            <TableCell>{item.label}</TableCell>
            <TableCell className="text-right tabular-nums">{item.value.toLocaleString()}</TableCell>
            <TableCell className="text-right tabular-nums">{item.percent.toFixed(1)}%</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function BreakdownPie({ title, items }: { title: string; items: AdminDashboardBreakdownItem[] }) {
  const data = items.filter((item) => item.value > 0)
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="px-5 py-4">
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      <Separator />
      <div className="p-5">
        <ChartContainer config={{ value: { label: title } }} className="h-[280px] w-full">
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent nameKey="label" />} />
            <Pie data={data} dataKey="value" nameKey="label" innerRadius={58} outerRadius={92} paddingAngle={2}>
              {data.map((item, index) => (
                <Cell key={item.key} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
      </div>
    </section>
  )
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <Input type="date" value={value} onChange={(event) => onChange(event.currentTarget.value)} className="h-9 w-40" />
    </label>
  )
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(event) => onChange(Math.max(0, Number(event.currentTarget.value) || 0))}
      />
    </label>
  )
}

function ListField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number[]
  onChange: (value: number[]) => void
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input
        value={value.join(", ")}
        onChange={(event) => onChange(parseNumberList(event.currentTarget.value))}
      />
    </label>
  )
}

function todayDate() {
  return new Date().toISOString().slice(0, 10)
}

function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function parseNumberList(value: string) {
  const parsed = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0)
  return parsed.length ? parsed : [0]
}

function formatValue(value: string | number) {
  return typeof value === "number" ? value.toLocaleString() : value
}

function userShare(value: number, total: number) {
  return `${total > 0 ? ((value / total) * 100).toFixed(1) : "0.0"}%`
}
