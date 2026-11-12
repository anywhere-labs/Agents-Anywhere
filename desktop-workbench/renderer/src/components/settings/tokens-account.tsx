"use client"

import * as React from "react"
import { Check, ChevronRight, Copy, ExternalLink, Pencil, RefreshCw, X } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts"
import { toast } from "sonner"

import { SettingsSection } from "@/components/settings/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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
  summarizeUsage,
  tokensModels,
  vendorGroups,
  type TokensModel,
  type UsageSummary,
} from "@/features/model-config/presentation"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

type Translate = ReturnType<typeof useTranslations<"pages.settings.modelConfigs">>
export type Tab = "account" | "models" | "runtimes"
const EMPTY: ModelPreferences = { disabled: [], names: {} }

/**
 * The linked Tokens Anywhere account: account and usage, models and connection,
 * and the runtimes using the channel with their switching progress.
 */
export function TokensAccount({
  token,
  profile,
  fallbackAccount,
  action,
  connection,
  runtimes,
  syncing,
  initialTab = "account",
  onSync,
  onChanged,
  errorText,
}: {
  token: string
  profile: ModelProfile | undefined
  initialTab?: Tab
  fallbackAccount: { id: string; displayName: string | null; email: string | null } | undefined
  action: React.ReactNode
  /** The address and key runtimes use, with its own actions. */
  connection: React.ReactNode
  runtimes?: React.ReactNode
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
    window.addEventListener("focus", loadInfo)
    return () => window.removeEventListener("focus", loadInfo)
  }, [loadInfo])

  const account = info?.account ?? fallbackAccount
  const name = account?.displayName ?? account?.email ?? account?.id ?? ""
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-0">
      <SettingsSection
        variant="plain"
        contentClassName="flex flex-col gap-6"
        title={(
          <span className="flex items-center gap-2">
            {t("account.title")}
            <Badge variant="outline" className="font-normal">Beta</Badge>
          </span>
        )}
        action={action}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <TabsList variant="line">
            <TabsTrigger value="account">{t("account.tabAccount")}</TabsTrigger>
            <TabsTrigger value="models">{t("account.tabModelsConnection")}</TabsTrigger>
            {runtimes ? <TabsTrigger value="runtimes">{t("runtimes.title")}</TabsTrigger> : null}
          </TabsList>
          <Separator />
        </div>
        <TabsContent value="account" className="flex flex-col gap-8">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col justify-between gap-4 rounded-xl border border-border p-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium uppercase">
                  {name.slice(0, 1) || "?"}
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium" title={name}>{name}</span>
                  {account?.email && account.email !== name ? (
                    <span className="truncate text-xs text-muted-foreground" title={account.email}>{account.email}</span>
                  ) : null}
                </div>
              </div>
              {info ? <ExternalTextLink onClick={() => void openExternal(info.links.console)}>{t("account.moreInfo")}</ExternalTextLink> : null}
            </div>
            <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border p-5">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs text-muted-foreground">{t("account.balance")}</span>
                <Button size="sm" disabled={!info} onClick={() => info && void openExternal(info.links.billing)}>
                  {t("account.topUp")}<ExternalLink data-icon="inline-end" />
                </Button>
              </div>
              {info ? (
                <>
                  <span className="text-3xl font-semibold tracking-tight tabular-nums">{formatYuan(amountUnits(info.balance.balance))}</span>
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
          </div>
          {tab === "account" ? <UsageBlock token={token} detailsUrl={info?.links.usage ?? null} /> : null}
        </TabsContent>
        {/* Kept mounted so unsaved model changes survive a look at the account page. */}
        <TabsContent value="models" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden">
          {connection}
          <ModelsBlock token={token} profile={profile} syncing={syncing} onSync={onSync} onChanged={onChanged} errorText={errorText} />
          {profile ? <ProtocolAddresses profile={profile} /> : null}
        </TabsContent>
        {runtimes ? (
          <TabsContent value="runtimes" forceMount className="data-[state=inactive]:hidden">
            {runtimes}
          </TabsContent>
        ) : null}
      </SettingsSection>
    </Tabs>
  )
}

/** A titled part of a page: a heading line with a note and actions, then its body. */
export function AccountBlock({
  title,
  meta,
  action,
  description,
  children,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  action?: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="text-sm font-medium">{title}</h3>
          {meta ? <span className="text-xs text-muted-foreground tabular-nums">{meta}</span> : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {description ? <p className="-mt-1 text-xs text-muted-foreground">{description}</p> : null}
      {children}
    </section>
  )
}

function ExternalTextLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      onClick={onClick}
    >
      {children}<ExternalLink className="size-3" />
    </button>
  )
}

function ProtocolAddresses({ profile }: { profile: ModelProfile }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [open, setOpen] = React.useState(false)
  if (!profile.offers.length) return null
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          {t("account.protocolAddresses")}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col divide-y divide-border">
          {profile.offers.map((offer) => (
            <div key={offer.format} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-sm">
              <span className="w-44 shrink-0 text-muted-foreground">{t(`protocols.${offer.format}`)}</span>
              <span className="min-w-0 flex-1 break-all font-mono text-xs">{offer.baseUrl}</span>
              <CopyButton value={offer.baseUrl} />
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function CopyButton({ value }: { value: string }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-muted-foreground"
      onClick={() => copyText(value).then(() => setCopied(true), () => toast.error(t("account.copyFailed")))}
    >
      {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
      {t(copied ? "account.copied" : "account.copy")}
    </Button>
  )
}

function ModelsBlock({
  token,
  profile,
  syncing,
  onSync,
  onChanged,
  errorText,
}: {
  token: string
  profile: ModelProfile | undefined
  syncing: boolean
  onSync: () => void
  onChanged: () => void
  errorText: (error: unknown) => string
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const models = React.useMemo(() => (profile ? tokensModels(profile) : []), [profile])
  const groups = React.useMemo(() => vendorGroups(models), [models])
  // Which protocols reach each model, so a group can say how runtimes call it.
  const protocolsOf = React.useCallback((group: TokensModel[]) => {
    const ids = new Set(group.map((model) => model.id))
    return (profile?.offers ?? []).filter((offer) => offer.models.some((model) => ids.has(model.id))).map((offer) => offer.format)
  }, [profile])
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

  const refresh = (
    <Button size="sm" variant="ghost" onClick={onSync} disabled={syncing}>
      {syncing ? <Spinner /> : <RefreshCw data-icon="inline-start" />}{t("account.refresh")}
    </Button>
  )

  if (!models.length) {
    return (
      <AccountBlock title={t("account.tabModels")} action={refresh}>
        <p className="py-4 text-sm text-muted-foreground">{t("account.noModels")}</p>
      </AccountBlock>
    )
  }

  return (
    <AccountBlock
      title={t("account.tabModels")}
      meta={t("account.enabledCount", { enabled: enabledCount, total: models.length })}
      action={refresh}
      description={t("account.modelsHint")}
    >
      <div className="flex flex-col divide-y divide-border">
        {groups.map((group) => {
          const label = group.label ?? t("account.otherVendor")
          const on = group.models.filter((model) => !disabled.has(model.id)).length
          const isOpen = expanded.has(group.key)
          const formats = protocolsOf(group.models)
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
                    <span className="truncate sm:w-28 sm:flex-none">{label}</span>
                    <span className="text-xs font-normal text-muted-foreground tabular-nums sm:w-12">{on}/{group.models.length}</span>
                    {formats.length ? (
                      <span className="hidden truncate text-xs font-normal text-muted-foreground sm:inline">
                        {formats.length === 1 && formats[0] === "anthropic"
                          ? t("account.anthropicProtocol")
                          : formats.map((format) => t(`protocolsShort.${format}`)).join(" · ")}
                      </span>
                    ) : null}
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
            <Button size="sm" disabled={saving || enabledCount === 0} onClick={() => void save(next)}>
              {saving ? <Spinner /> : null}{t("account.saveApply")}
            </Button>
          </div>
        </div>
      ) : null}
    </AccountBlock>
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

function UsageBlock({ token, detailsUrl }: { token: string; detailsUrl: string | null }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const locale = useLocale()
  const [days, setDays] = React.useState(7)
  const [model, setModel] = React.useState<string | null>(null)
  const [asTable, setAsTable] = React.useState(false)
  const [revision, setRevision] = React.useState(0)
  const [usage, setUsage] = React.useState<TokensUsage | null>(null)
  const [failed, setFailed] = React.useState(false)
  const load = () => setRevision((value) => value + 1)

  React.useEffect(() => {
    let active = true
    setFailed(false)
    setUsage(null)
    modelConfigApi.tokensUsage(token, days).then((value) => {
      if (active) setUsage(value)
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [token, days, revision])

  const all = usage ? summarizeUsage(usage, null) : null
  // Keep the filter valid when changing the period or refreshing the model list.
  const selectedModel = model !== null && all?.models.some((row) => row.model === model) ? model : null
  const summary = usage ? summarizeUsage(usage, selectedModel) : null
  const number = (value: number) => formatCompactNumber(value, locale)
  const modelName = (value: string) => value || t("account.unknownModel")

  return (
    <AccountBlock
      title={t("account.tabUsage")}
      action={detailsUrl ? (
        <Button size="sm" variant="ghost" onClick={() => void openExternal(detailsUrl)}>
          {t("account.usageDetails")}<ExternalLink data-icon="inline-end" />
        </Button>
      ) : null}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            aria-label={t("account.period")}
            value={String(days)}
            onValueChange={(value) => { if (value) setDays(Number(value)) }}
          >
            <ToggleGroupItem value="7">{t("account.days7")}</ToggleGroupItem>
            <ToggleGroupItem value="30">{t("account.days30")}</ToggleGroupItem>
          </ToggleGroup>
          <NativeSelect size="sm" aria-label={t("account.modelFilter")} value={JSON.stringify(selectedModel)} onChange={(event) => setModel(JSON.parse(event.target.value) as string | null)} disabled={!all}>
            <NativeSelectOption value="null">{t("account.allModels")}</NativeSelectOption>
            {all?.models.map((row) => <NativeSelectOption key={row.model} value={JSON.stringify(row.model)}>{modelName(row.model)}</NativeSelectOption>)}
          </NativeSelect>
          <Button size="sm" variant="outline" className="ml-auto" onClick={load} disabled={!usage && !failed}>
            {!usage && !failed ? <Spinner /> : <RefreshCw data-icon="inline-start" />}{t("account.refresh")}
          </Button>
        </div>
        {failed ? (
          <div className="flex items-center gap-2 rounded-xl border border-border p-5 text-sm text-muted-foreground">
            {t("account.usageFailed")}
            <Button size="sm" variant="ghost" onClick={load}><RefreshCw data-icon="inline-start" />{t("retry")}</Button>
          </div>
        ) : !summary ? (
          <div className="flex h-72 items-center justify-center rounded-xl border border-border"><Spinner /></div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-3">
              <Stat label={t("account.cost")} value={formatYuan(summary.cost)} />
              <Stat label={t("account.requests")} value={t("account.requestCount", { count: summary.requests })} />
              <Stat label={t("account.tokens")} value={number(summary.tokens)} detail={t("account.tokenDetail", {
                input: number(summary.inputTokens), output: number(summary.outputTokens), cache: number(summary.cacheTokens),
              })} />
            </div>
            <UsageCard
              title={t("account.dailyCost")}
              action={summary.cost > 0 ? (
                <Button size="sm" variant="ghost" aria-pressed={asTable} onClick={() => setAsTable((value) => !value)}>
                  {t(asTable ? "account.chartView" : "account.tableView")}
                </Button>
              ) : null}
            >
              {asTable && summary.cost > 0 ? (
                <Table>
                  <TableCaption className="sr-only">{t("account.dailyCost")}</TableCaption>
                  <TableHeader><TableRow><TableHead>{t("account.date")}</TableHead><TableHead className="text-right">{t("account.cost")}</TableHead></TableRow></TableHeader>
                  <TableBody>{summary.daily.map((row) => (
                    <TableRow key={row.date}><TableCell>{row.date}</TableCell><TableCell className="text-right tabular-nums">{formatYuan(row.cost)}</TableCell></TableRow>
                  ))}</TableBody>
                </Table>
              ) : (
                <DailyCostChart summary={summary} modelName={modelName} t={t} />
              )}
            </UsageCard>
            <UsageCard title={t("account.byModel")}>
              {summary.models.length ? (
                <Table>
                  <TableCaption className="sr-only">{t("account.byModel")}</TableCaption>
                  <TableHeader><TableRow>
                    <TableHead>{t("account.modelFilter")}</TableHead>
                    {["cost", "requests", "inputTokens", "outputTokens", "cacheTokens"].map((key) => <TableHead key={key} className="text-right">{t(`account.${key}`)}</TableHead>)}
                  </TableRow></TableHeader>
                  <TableBody>{summary.models.map((row) => (
                    <TableRow key={row.model}>
                      <TableCell className="max-w-64 truncate" title={modelName(row.model)}>{modelName(row.model)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatYuan(row.cost)}</TableCell>
                      {[row.requests, row.inputTokens, row.outputTokens, row.cacheTokens].map((value, index) => <TableCell key={index} className="text-right tabular-nums" title={value.toLocaleString(locale)}>{number(value)}</TableCell>)}
                    </TableRow>
                  ))}</TableBody>
                </Table>
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">{t("account.noUsage")}</p>
              )}
            </UsageCard>
          </>
        )}
      </div>
    </AccountBlock>
  )
}

// The models with their own color; the rest share one bar segment.
const SERIES = 5
const yuan = (units: number) => units / 10_000

/** Cost per day stacked by model, with the total above each bar and a legend of what each model spent. */
function DailyCostChart({ summary, modelName, t }: { summary: UsageSummary; modelName: (model: string) => string; t: Translate }) {
  const shown = summary.models.filter((row) => row.cost > 0)
  const own = shown.slice(0, SERIES)
  const rest = shown.slice(SERIES)
  const series = [
    ...own.map((row, index) => ({ key: `m${index}`, label: modelName(row.model), color: `var(--chart-${index + 1})`, cost: row.cost, models: [row.model] })),
    ...(rest.length ? [{ key: "other", label: t("account.otherModels"), color: "var(--muted-foreground)", cost: rest.reduce((sum, row) => sum + row.cost, 0), models: rest.map((row) => row.model) }] : []),
  ]
  const config: ChartConfig = Object.fromEntries(series.map((item) => [item.key, { label: item.label, color: item.color }]))
  const data = summary.daily.map((day) => ({
    date: day.date,
    total: yuan(day.cost),
    ...Object.fromEntries(series.map((item) => [item.key, yuan(item.models.reduce((sum, model) => sum + (day.byModel[model] ?? 0), 0))])),
  }))
  // Totals above every bar crowd a month; then they stay in the tooltip.
  const labelled = summary.daily.filter((day) => day.cost > 0).length <= 10
  const money = (value: unknown) => formatYuan(Math.round(Number(value) * 10_000))

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <ChartContainer config={config} className="aspect-auto h-60 w-full" aria-label={t("account.dailyCost")}>
          <BarChart accessibilityLayer data={data} margin={{ top: 24, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickFormatter={formatShortDate} minTickGap={24} />
            <YAxis tickLine={false} axisLine={false} width={64} domain={[0, (max: number) => (max > 0 ? max : 1)]} tickFormatter={money} />
            {series.length ? (
              <ChartTooltip
                cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                content={(
                  <ChartTooltipContent
                    labelFormatter={(_, items) => String(items[0]?.payload?.date ?? "")}
                    formatter={(value, key) => Number(value) > 0 ? (
                      <div className="flex w-full items-center gap-2">
                        <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: `var(--color-${key})` }} />
                        <span className="text-muted-foreground">{config[String(key)]?.label}</span>
                        <span className="ml-auto pl-4 font-mono font-medium text-foreground tabular-nums">{money(value)}</span>
                      </div>
                    ) : null}
                  />
                )}
              />
            ) : null}
            {series.length ? series.map((item, index) => (
              <Bar key={item.key} dataKey={item.key} stackId="cost" fill={`var(--color-${item.key})`} maxBarSize={32} isAnimationActive={false} radius={index === series.length - 1 ? [4, 4, 0, 0] : 0}>
                {labelled && index === series.length - 1 ? (
                  <LabelList dataKey="total" position="top" offset={8} className="fill-foreground" fontSize={12} formatter={(value: unknown) => (Number(value) > 0 ? money(value) : "")} />
                ) : null}
              </Bar>
            )) : <Bar dataKey="total" isAnimationActive={false} />}
          </BarChart>
        </ChartContainer>
        {series.length ? null : (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center pb-6 pl-16 text-sm text-muted-foreground">{t("account.noUsage")}</p>
        )}
      </div>
      {series.length ? (
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {series.map((item) => (
            <li key={item.key} className="flex min-w-0 items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} />
              <span className="truncate" title={item.label}>{item.label}</span>
              <span className="text-muted-foreground tabular-nums">{formatYuan(item.cost)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function UsageCard({ title, action, children }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-5">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border p-5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-2xl font-semibold tracking-tight tabular-nums" title={value}>{value}</span>
      {detail ? <span className="text-xs text-muted-foreground tabular-nums">{detail}</span> : null}
    </div>
  )
}
