"use client"

import * as React from "react"
import { Check, ChevronRight, ExternalLink, Pencil, RefreshCw, RotateCcw, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { toast } from "sonner"

import { SettingsSection } from "@/components/settings/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { formatCompactNumber, formatShortDate } from "@/features/admin-usage/report-helpers"
import type { ModelPreferences, ModelProfile } from "@/features/dashboard/types"
import { modelConfigApi, type TokensAccount as TokensAccountInfo, type TokensUsage } from "@/features/model-config/api"
import { openExternal } from "@/features/model-config/open-link"
import {
  amountUnits,
  cleanPreferences,
  formatTokenWindow,
  formatYuan,
  samePreferences,
  summarizeUsage,
  tokensModels,
  vendorGroups,
  type TokensModel,
} from "@/features/model-config/presentation"
import { cn } from "@/lib/utils"

type Translate = ReturnType<typeof useTranslations<"pages.settings.modelConfigs">>
export type Tab = "models" | "usage" | "devices"
const EMPTY: ModelPreferences = { disabled: [], names: {} }

/**
 * The linked Tokens Anywhere account: who it is, its balance, which of its
 * models runtimes get and under which names, what it has spent, and the
 * runtimes it is set up on.
 */
export function TokensAccount({
  token,
  profile,
  fallbackAccount,
  action,
  devices,
  syncing,
  applying,
  initialTab = "models",
  onSync,
  onChanged,
  errorText,
}: {
  token: string
  profile: ModelProfile | undefined
  applying: boolean
  initialTab?: Tab
  fallbackAccount: { id: string; displayName: string | null; email: string | null } | undefined
  action: React.ReactNode
  devices: React.ReactNode
  syncing: boolean
  onSync: () => void
  onChanged: () => void
  errorText: (error: unknown) => string
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [info, setInfo] = React.useState<TokensAccountInfo | null>(null)
  const [infoFailed, setInfoFailed] = React.useState(false)
  const [tab, setTab] = React.useState<Tab>(initialTab)

  const loadInfo = React.useCallback(() => {
    if (!token) return
    setInfoFailed(false)
    modelConfigApi.tokensAccount(token).then(setInfo).catch(() => setInfoFailed(true))
  }, [token])

  // Back from topping up in another tab, the balance should already show it.
  React.useEffect(() => {
    loadInfo()
    const onFocus = () => { if (document.visibilityState === "visible") loadInfo() }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onFocus)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onFocus)
    }
  }, [loadInfo])

  const account = info?.account ?? fallbackAccount
  const name = account?.displayName ?? account?.email ?? account?.id ?? ""
  return (
    <SettingsSection
      title={(
        <span className="flex items-center gap-2">
          {t("account.title")}
          <Badge variant="outline" className="font-normal">Beta</Badge>
        </span>
      )}
      description={applying ? (
        <span className="flex items-center gap-1.5"><Spinner className="size-3" />{t("account.applying")}</span>
      ) : undefined}
      action={action}
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border p-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium uppercase">
              {name.slice(0, 1) || "?"}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm font-medium" title={name}>{name}</span>
              {account?.email && account.email !== name ? (
                <span className="truncate text-xs text-muted-foreground" title={account.email}>{account.email}</span>
              ) : null}
              {info ? (
                <button
                  type="button"
                  className="flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => void openExternal(info.links.console)}
                >
                  {t("account.moreInfo")}<ExternalLink className="size-3" />
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex min-w-0 flex-col justify-between gap-3 rounded-lg border border-border p-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">{t("account.balance")}</span>
              {info ? (
                <>
                  <span className="text-2xl font-semibold tabular-nums">{formatYuan(amountUnits(info.balance.balance))}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t("account.balanceDetail", {
                      available: formatYuan(amountUnits(info.balance.available)),
                      bonus: formatYuan(amountUnits(info.balance.bonus)),
                    })}
                  </span>
                </>
              ) : infoFailed ? (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  {t("account.loadFailed")}
                  <Button size="sm" variant="ghost" onClick={loadInfo}><RefreshCw data-icon="inline-start" />{t("retry")}</Button>
                </span>
              ) : <Spinner className="my-2" />}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setTab("usage")}>{t("account.viewUsage")}</Button>
              <Button size="sm" disabled={!info} onClick={() => info && void openExternal(info.links.billing)}>
                {t("account.topUp")}<ExternalLink data-icon="inline-end" />
              </Button>
            </div>
          </div>
        </div>
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <TabsList>
            <TabsTrigger value="models">{t("account.tabModels")}</TabsTrigger>
            <TabsTrigger value="usage">{t("account.tabUsage")}</TabsTrigger>
            <TabsTrigger value="devices">{t("account.tabDevices")}</TabsTrigger>
          </TabsList>
          <TabsContent value="models" className="pt-2">
            <ModelsTab token={token} profile={profile} syncing={syncing} applying={applying} onSync={onSync} onChanged={onChanged} errorText={errorText} />
          </TabsContent>
          <TabsContent value="usage" className="pt-2">
            {tab === "usage" ? <UsageTab token={token} detailsUrl={info?.links.usage ?? null} /> : null}
          </TabsContent>
          <TabsContent value="devices" className="pt-2">{devices}</TabsContent>
        </Tabs>
      </div>
    </SettingsSection>
  )
}

function ModelsTab({
  token,
  profile,
  syncing,
  applying,
  onSync,
  onChanged,
  errorText,
}: {
  token: string
  profile: ModelProfile | undefined
  syncing: boolean
  applying: boolean
  onSync: () => void
  onChanged: () => void
  errorText: (error: unknown) => string
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const models = React.useMemo(() => (profile ? tokensModels(profile) : []), [profile])
  const groups = React.useMemo(() => vendorGroups(models), [models])
  const saved = profile?.preferences ?? EMPTY
  const [draft, setDraft] = React.useState<ModelPreferences>(saved)
  const [saving, setSaving] = React.useState(false)
  const [open, setOpen] = React.useState<Set<string> | null>(null)

  // A save or a push from another client replaces what this page started from.
  const savedKey = JSON.stringify(saved)
  React.useEffect(() => { setDraft(JSON.parse(savedKey) as ModelPreferences) }, [savedKey])

  const disabled = new Set(draft.disabled)
  const enabledCount = models.filter((model) => !disabled.has(model.id)).length
  const next = cleanPreferences(draft, models)
  const changes = changeCount(cleanPreferences(saved, models), next)
  const expanded = open ?? new Set(models.length <= 12 ? groups.map((group) => group.key) : [])

  const setEnabled = (ids: string[], on: boolean) => setDraft((current) => {
    const off = new Set(current.disabled)
    for (const id of ids) {
      if (on) off.delete(id)
      else off.add(id)
    }
    return { ...current, disabled: [...off] }
  })
  const rename = (id: string, value: string | null) => setDraft((current) => {
    const names = { ...current.names }
    if (value) names[id] = value
    else delete names[id]
    return { ...current, names }
  })

  const save = async (preferences: ModelPreferences) => {
    setSaving(true)
    try {
      const result = await modelConfigApi.saveTokensModels(token, preferences)
      toast.success(result.applying ? t("account.saved") : t("account.savedNoRuntimes"))
      onChanged()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  if (!models.length) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm text-muted-foreground">
        <span>{t("account.noModels")}</span>
        <Button size="sm" variant="outline" onClick={onSync} disabled={syncing}>
          {syncing ? <Spinner /> : <RefreshCw data-icon="inline-start" />}{t("account.refresh")}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm">{t("account.modelsSummary", { total: models.length, enabled: enabledCount })}</span>
          <span className="text-xs text-muted-foreground">{t("account.modelsHint")}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={saving || applying || samePreferences(cleanPreferences(saved, models), EMPTY)}
            onClick={() => void save(EMPTY)}
          >
            <RotateCcw data-icon="inline-start" />{t("account.restoreDefaults")}
          </Button>
          <Button size="sm" variant="outline" onClick={onSync} disabled={syncing}>
            {syncing ? <Spinner /> : <RefreshCw data-icon="inline-start" />}{t("account.refresh")}
          </Button>
        </div>
      </div>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {groups.map((group) => {
          const label = group.label ?? t("account.otherVendor")
          const on = group.models.filter((model) => !disabled.has(model.id)).length
          const isOpen = expanded.has(group.key)
          return (
            <Collapsible
              key={group.key}
              open={isOpen}
              onOpenChange={(value) => setOpen(() => {
                const set = new Set(expanded)
                if (value) set.add(group.key)
                else set.delete(group.key)
                return set
              })}
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium">
                    <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                    <span className="truncate">{label}</span>
                    <span className="text-xs font-normal text-muted-foreground tabular-nums">{on}/{group.models.length}</span>
                  </button>
                </CollapsibleTrigger>
                <Switch
                  aria-label={t("account.toggleGroup", { vendor: label })}
                  checked={on === group.models.length}
                  onCheckedChange={(value) => setEnabled(group.models.map((model) => model.id), value)}
                />
              </div>
              <CollapsibleContent>
                <div className="flex flex-col divide-y divide-border border-t border-border bg-muted/30">
                  {group.models.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      name={draft.names[model.id] ?? null}
                      enabled={!disabled.has(model.id)}
                      onEnabled={(value) => setEnabled([model.id], value)}
                      onRename={(value) => rename(model.id, value)}
                      t={t}
                    />
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )
        })}
      </div>
      {changes > 0 ? (
        <div className="sticky bottom-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 shadow-sm">
          <span className={cn("text-sm", enabledCount === 0 && "text-destructive")}>
            {enabledCount === 0 ? t("account.needOneModel") : t("account.pending", { count: changes })}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(saved)}>{t("account.discard")}</Button>
            <Button size="sm" disabled={saving || applying || enabledCount === 0} onClick={() => void save(next)}>
              {saving ? <Spinner /> : null}{t("account.saveApply")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function changeCount(before: ModelPreferences, after: ModelPreferences): number {
  const ids = new Set([...before.disabled, ...after.disabled, ...Object.keys(before.names), ...Object.keys(after.names)])
  let count = 0
  for (const id of ids) {
    if (before.disabled.includes(id) !== after.disabled.includes(id) || (before.names[id] ?? "") !== (after.names[id] ?? "")) count += 1
  }
  return count
}

function ModelRow({
  model,
  name,
  enabled,
  onEnabled,
  onRename,
  t,
}: {
  model: TokensModel
  name: string | null
  enabled: boolean
  onEnabled: (value: boolean) => void
  onRename: (value: string | null) => void
  t: Translate
}) {
  const [editing, setEditing] = React.useState<string | null>(null)
  const shown = name || model.originalName
  const meta = [
    model.id !== shown ? model.id : null,
    model.contextWindow ? t("account.context", { size: formatTokenWindow(model.contextWindow) }) : null,
    model.maxOutputTokens ? t("account.output", { size: formatTokenWindow(model.maxOutputTokens) }) : null,
    model.image ? t("account.image") : null,
  ].filter(Boolean).join(" · ")
  const commit = () => {
    const value = (editing ?? "").trim()
    onRename(value && value !== model.originalName ? value : null)
    setEditing(null)
  }
  return (
    <div className={cn("flex items-center gap-3 py-2.5 pr-3 pl-9", !enabled && "text-muted-foreground")}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {editing !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              autoFocus
              className="h-8 max-w-64"
              value={editing}
              placeholder={t("account.renamePlaceholder")}
              maxLength={128}
              onChange={(event) => setEditing(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit()
                if (event.key === "Escape") setEditing(null)
              }}
            />
            <Button size="icon-sm" variant="ghost" aria-label={t("save")} onClick={commit}><Check /></Button>
            <Button size="icon-sm" variant="ghost" aria-label={t("cancel")} onClick={() => setEditing(null)}><X /></Button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate text-sm" title={shown}>{shown}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground"
              aria-label={t("account.rename")}
              onClick={() => setEditing(name ?? model.originalName)}
            >
              <Pencil />
            </Button>
          </div>
        )}
        {meta ? <span className="break-all text-xs text-muted-foreground">{meta}</span> : null}
        {/* The ID is already in the line above when the original name is the ID. */}
        {name && model.originalName !== model.id ? (
          <span className="text-xs text-muted-foreground">{t("account.originalName", { name: model.originalName })}</span>
        ) : null}
      </div>
      <Switch aria-label={t("account.toggleModel", { model: shown })} checked={enabled} onCheckedChange={onEnabled} />
    </div>
  )
}

function UsageTab({ token, detailsUrl }: { token: string; detailsUrl: string | null }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [days, setDays] = React.useState(7)
  const [model, setModel] = React.useState<string | null>(null)
  const [usage, setUsage] = React.useState<TokensUsage | null>(null)
  const [failed, setFailed] = React.useState(false)

  const load = React.useCallback(() => {
    setFailed(false)
    setUsage(null)
    modelConfigApi.tokensUsage(token, days).then(setUsage).catch(() => setFailed(true))
  }, [token, days])
  React.useEffect(load, [load])

  const summary = usage ? summarizeUsage(usage, model) : null
  const modelIds = usage ? [...new Set(usage.items.map((item) => item.model).filter((id): id is string => Boolean(id)))].sort() : []
  const chartConfig: ChartConfig = { cost: { label: t("account.cost"), color: "var(--chart-1)" } }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={String(days)}
          onValueChange={(value) => { if (value) setDays(Number(value)) }}
        >
          <ToggleGroupItem value="7">{t("account.days7")}</ToggleGroupItem>
          <ToggleGroupItem value="30">{t("account.days30")}</ToggleGroupItem>
        </ToggleGroup>
        <NativeSelect
          size="sm"
          aria-label={t("account.model")}
          value={model ?? ""}
          onChange={(event) => setModel(event.target.value || null)}
        >
          <NativeSelectOption value="">{t("account.allModels")}</NativeSelectOption>
          {modelIds.map((id) => <NativeSelectOption key={id} value={id}>{id}</NativeSelectOption>)}
          {model && !modelIds.includes(model) ? <NativeSelectOption value={model}>{model}</NativeSelectOption> : null}
        </NativeSelect>
      </div>
      {failed ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          {t("account.usageFailed")}
          <Button size="sm" variant="ghost" onClick={load}><RefreshCw data-icon="inline-start" />{t("retry")}</Button>
        </div>
      ) : !summary ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label={t("account.cost")} value={formatYuan(summary.cost)} />
            <Stat label={t("account.requests")} value={summary.requests.toLocaleString()} />
            <Stat label={t("account.tokens")} value={formatCompactNumber(summary.tokens)} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">{t("account.dailyCost")}</span>
            {summary.cost === 0 ? (
              <p className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">{t("account.noUsage")}</p>
            ) : (
              <ChartContainer config={chartConfig} className="aspect-auto h-48 w-full">
                <BarChart data={summary.daily.map((row) => ({ date: row.date, cost: row.cost / 10_000 }))} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.6} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={16} tickFormatter={formatShortDate} />
                  <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(value: number) => `¥${formatCompactNumber(value)}`} />
                  <ChartTooltip
                    cursor={{ fill: "var(--muted)" }}
                    content={<ChartTooltipContent formatter={(value) => formatYuan(Math.round(Number(value) * 10_000))} />}
                  />
                  <Bar dataKey="cost" fill="var(--color-cost)" radius={[3, 3, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ChartContainer>
            )}
          </div>
          {summary.models.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("account.model")}</TableHead>
                  <TableHead className="text-right">{t("account.requests")}</TableHead>
                  <TableHead className="text-right">{t("account.tokens")}</TableHead>
                  <TableHead className="text-right">{t("account.cost")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.models.map((row) => (
                  <TableRow key={row.model}>
                    <TableCell className="max-w-56 truncate" title={row.model}>{row.model || t("account.unknownModel")}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.requests.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCompactNumber(row.tokens)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatYuan(row.cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{t("account.usageNote")}</span>
        {detailsUrl ? (
          <button
            type="button"
            className="flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => void openExternal(detailsUrl)}
          >
            {t("account.usageDetails")}<ExternalLink className="size-3" />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border px-3 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-lg font-semibold tabular-nums" title={value}>{value}</span>
    </div>
  )
}
