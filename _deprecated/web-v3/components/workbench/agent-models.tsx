"use client"

// The 「模型与订阅」 section of an agent's settings: how much of its subscription it has used (Claude Code, Codex: read
// on the device with the agent's own sign-in), and which model provider it answers through when Agents Anywhere starts
// it — its own configuration, or one of the providers the user keeps in CC Switch (https://github.com/farion1231/cc-switch),
// which can be added, changed and removed here too. Choosing one reaches only the processes Agents Anywhere starts: the
// agent's own configuration (and the agent in a terminal) keeps what CC Switch has in use. Keys never leave the device.

import { useCallback, useEffect, useState } from "react"
import { MeshCallError } from "meshcall/web"
import { CheckIcon, LoaderCircleIcon, PencilIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Card, Group, Row } from "@/components/workbench/settings-parts"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { AgentEntry, AgentUpdate, DeviceRecord, ModelProvider, ProviderList, SubscriptionUsage } from "@/lib/types/v3"
import { isGatewayUrl } from "@/lib/workbench/agents"
import { cn } from "@/lib/utils"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

const CC_SWITCH_URL = "https://github.com/farion1231/cc-switch"

export function AgentModels({
  tunnelManager,
  device,
  agentId,
  name,
  entry,
  online,
  update,
  onSignIn,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  agentId: string
  name: string
  entry: AgentEntry
  online: boolean
  /** Change the agent; resolves with it (null: refused, already said). */
  update: (patch: Omit<AgentUpdate, "id">) => Promise<AgentEntry | null>
  /** Sign in to the agent again (its subscription's sign-in has run out); absent when it cannot be done here. */
  onSignIn?: () => void
}) {
  return (
    <>
      {entry.usage && <UsageGroup tunnelManager={tunnelManager} device={device} agentId={agentId} name={name} online={online} onSignIn={onSignIn} />}
      {entry.cc_switch && (
        <ProvidersGroup tunnelManager={tunnelManager} device={device} agentId={agentId} name={name} entry={entry} online={online} update={update} />
      )}
    </>
  )
}

// ── Subscription usage ───────────────────────────────────────────────────────────────────────────────────────────

const WINDOW_KEYS = {
  five_hour: "models.window.fiveHour",
  seven_day: "models.window.week",
  seven_day_opus: "models.window.weekOpus",
  seven_day_sonnet: "models.window.weekSonnet",
  seven_day_fable: "models.window.weekFable",
  "30_day": "models.window.month",
} as const
const windowKey = (name: string) => (name in WINDOW_KEYS ? WINDOW_KEYS[name as keyof typeof WINDOW_KEYS] : undefined)

function UsageGroup({
  tunnelManager,
  device,
  agentId,
  name,
  online,
  onSignIn,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  agentId: string
  name: string
  online: boolean
  onSignIn?: () => void
}) {
  const { t, locale } = useI18n()
  const [usage, setUsage] = useState<SubscriptionUsage | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (refresh: boolean) => {
      if (!tunnelManager || !device || !online) return
      setLoading(true)
      try {
        setUsage(await tunnelManager.subscriptionUsage(device, agentId, refresh))
        setFailure(null)
      } catch (err) {
        setFailure(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [agentId, device, online, tunnelManager]
  )
  useEffect(() => {
    queueMicrotask(() => void load(false))
  }, [load])

  // From when it was read: what it says holds for that moment.
  const resetsIn = (iso: string, now: number) => {
    const ms = Date.parse(iso) - now
    if (!Number.isFinite(ms) || ms <= 0) return null
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
    const minutes = Math.round(ms / 60_000)
    const when =
      minutes >= 2 * 24 * 60 ? rtf.format(Math.round(minutes / 1440), "day") : minutes >= 60 ? rtf.format(Math.round(minutes / 60), "hour") : rtf.format(Math.max(1, minutes), "minute")
    return t("models.resetsIn", { when })
  }

  let body: React.ReactNode
  if (failure) body = <p className="py-3 text-sm text-muted-foreground">{t("models.usageError", { error: failure })}</p>
  else if (!usage) {
    body = (
      <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        {t("common.loading")}
      </p>
    )
  } else if (usage.status === "signed_out") body = <p className="py-3 text-sm text-muted-foreground">{t("models.signedOut", { agent: name })}</p>
  else if (usage.status === "expired") {
    body = (
      <Row label={t("models.expired")} hint={t("models.expiredHint", { agent: name })}>
        {onSignIn && (
          <Button variant="outline" size="sm" disabled={!online} onClick={onSignIn}>
            {t("agentSignIn.action")}
          </Button>
        )}
      </Row>
    )
  } else if (usage.status === "refresh_pending") body = <p className="py-3 text-sm text-muted-foreground">{t("models.refreshPending", { agent: name })}</p>
  else if (usage.status === "error") body = <p className="py-3 text-sm text-muted-foreground">{t("models.usageError", { error: usage.error ?? "" })}</p>
  else {
    body = (
      <>
        {usage.plan && <Row label={t("models.plan")}><span className="text-sm text-muted-foreground">{usage.plan}</span></Row>}
        {usage.windows.map((window) => {
          const percent = Math.min(100, Math.max(0, window.used_percent))
          const resets = window.resets_at ? resetsIn(window.resets_at, usage.queried_at) : null
          return (
            <div key={window.name} className="space-y-2 py-3">
              <div className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-foreground">{windowKey(window.name) ? t(windowKey(window.name)!) : window.name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t("models.used", { percent: Math.round(percent) })}
                  {resets ? ` · ${resets}` : ""}
                </span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={Math.round(percent)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className={cn("h-full rounded-full bg-foreground/70", percent >= 90 && "bg-destructive")} style={{ width: `${percent}%` }} />
              </div>
            </div>
          )
        })}
        {usage.windows.length === 0 && <p className="py-3 text-sm text-muted-foreground">{t("models.noWindows")}</p>}
        {usage.credits !== undefined && (
          <Row label={t("models.credits")}>
            <span className="text-sm tabular-nums text-muted-foreground">{usage.credits.toLocaleString(locale)}</span>
          </Row>
        )}
        {usage.extra?.enabled && (
          <Row label={t("models.extra")}>
            <span className="text-sm tabular-nums text-muted-foreground">
              {usage.extra.used ?? 0}
              {usage.extra.monthly_limit !== undefined ? ` / ${usage.extra.monthly_limit}` : ""}
              {usage.extra.currency ? ` ${usage.extra.currency}` : ""}
            </span>
          </Row>
        )}
      </>
    )
  }

  return (
    <Group
      title={t("models.usage")}
      description={t("models.usageHint", { agent: name })}
      action={
        <Button variant="ghost" size="icon-xs" aria-label={t("common.refresh")} disabled={!online || loading} onClick={() => void load(true)}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      }
    >
      <Card>{body}</Card>
    </Group>
  )
}

// ── CC Switch's providers ────────────────────────────────────────────────────────────────────────────────────────

type Editing = { provider: ModelProvider | null } | null

function ProvidersGroup({
  tunnelManager,
  device,
  agentId,
  name,
  entry,
  online,
  update,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  agentId: string
  name: string
  entry: AgentEntry
  online: boolean
  update: (patch: Omit<AgentUpdate, "id">) => Promise<AgentEntry | null>
}) {
  const { t } = useI18n()
  const [list, setList] = useState<ProviderList | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [choosing, setChoosing] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [removing, setRemoving] = useState<ModelProvider | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!tunnelManager || !device || !online) return
    try {
      setList(await tunnelManager.listProviders(device, agentId))
      setFailure(null)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    }
  }, [agentId, device, online, tunnelManager])
  useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])

  const selected = entry.cc_switch?.provider?.id ?? list?.selected ?? null
  const current = list?.providers.find((p) => p.current)
  const choices = list?.providers.filter((p) => !p.official) ?? []

  const choose = async (providerId: string) => {
    if (providerId === (selected ?? "")) return
    setChoosing(providerId)
    const next = await update({ provider: providerId })
    setChoosing(null)
    if (next) toast.success(next.running > 0 ? t("agent.savedRestart") : t("common.saved"))
  }

  const remove = async () => {
    if (!tunnelManager || !device || !removing) return
    setBusy(true)
    try {
      await tunnelManager.removeProvider(device, agentId, removing.id)
      setRemoving(null)
      await load()
    } catch (err) {
      toast.error(providerError(err, t))
    } finally {
      setBusy(false)
    }
  }

  const poweredBy = (
    <p className="px-1 text-xs text-muted-foreground">
      Powered by{" "}
      <a href={CC_SWITCH_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
        CC Switch
      </a>
    </p>
  )

  if (entry.cc_switch && !entry.cc_switch.available && !list?.available) {
    return (
      <Group title={t("models.providers")}>
        <Card>
          <p className="py-3 text-sm text-muted-foreground">{t("models.noCcSwitch")}</p>
        </Card>
        {poweredBy}
      </Group>
    )
  }

  const option = (key: string, label: string, hint: string | undefined, active: boolean, actions?: React.ReactNode, warn = false) => (
    <div key={key} className="flex items-center gap-2 py-1.5">
      <button
        type="button"
        role="radio"
        aria-checked={active}
        disabled={!online || choosing !== null}
        onClick={() => void choose(key)}
        className="flex min-w-0 flex-1 items-center gap-3 py-1.5 text-left disabled:opacity-60"
      >
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm", warn ? "text-destructive" : "text-foreground")}>{label}</span>
          {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
        </span>
        {choosing === key ? (
          <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          active && <CheckIcon className="size-4 shrink-0 text-foreground" />
        )}
      </button>
      {actions}
    </div>
  )

  return (
    <Group
      title={t("models.providers")}
      description={t("models.providersHint", { agent: name })}
      action={
        <Button variant="ghost" size="xs" disabled={!online || !list?.available} onClick={() => setEditing({ provider: null })}>
          {t("models.add")}
        </Button>
      }
    >
      <Card>
        {failure ? (
          <p className="py-3 text-sm text-muted-foreground">{failure}</p>
        ) : !list ? (
          <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            {t("common.loading")}
          </p>
        ) : (
          <div role="radiogroup" aria-label={t("models.providers")} className="divide-y divide-border">
            {option(
              "",
              t("models.own", { agent: name }),
              current ? (current.official ? t("models.ownOfficial") : t("models.ownCurrent", { provider: current.name })) : undefined,
              selected === null
            )}
            {selected !== null && !list.providers.some((p) => p.id === selected) &&
              option(selected, t("models.gone"), t("models.goneHint"), true, undefined, true)}
            {choices.map((provider) =>
              option(
                provider.id,
                provider.name,
                [provider.base_url, provider.model, provider.current ? t("models.currentTag") : undefined].filter(Boolean).join(" · "),
                provider.id === selected,
                <span className="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon-xs" aria-label={t("models.edit", { name: provider.name })} disabled={!online} onClick={() => setEditing({ provider })}>
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("models.remove", { name: provider.name })}
                    disabled={!online || provider.current || provider.id === selected}
                    onClick={() => setRemoving(provider)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </span>
              )
            )}
          </div>
        )}
      </Card>
      {poweredBy}

      <ProviderDialog
        key={editing ? (editing.provider?.id ?? "new") : "closed"}
        editing={editing}
        onClose={() => setEditing(null)}
        save={async (input) => {
          if (!tunnelManager || !device) return false
          try {
            const saved = await tunnelManager.saveProvider(device, { id: agentId, ...input })
            setEditing(null)
            await load()
            toast.success(t("common.saved"))
            return saved
          } catch (err) {
            toast.error(providerError(err, t))
            return false
          }
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
        title={t("models.removeTitle", { name: removing?.name ?? "" })}
        description={t("models.removeDesc")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={busy}
        onConfirm={() => void remove()}
      />
    </Group>
  )
}

function providerError(err: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  const reason = err instanceof MeshCallError ? err.reason : undefined
  if (reason === "provider_in_use") return t("models.inUse")
  if (reason === "provider_current") return t("models.isCurrent")
  return err instanceof Error ? err.message : String(err)
}

function ProviderDialog({
  editing,
  onClose,
  save,
}: {
  editing: Editing
  onClose: () => void
  save: (input: { provider_id?: string; name: string; base_url: string; api_key?: string; model?: string }) => Promise<unknown>
}) {
  const { t } = useI18n()
  const provider = editing?.provider ?? null
  const [form, setForm] = useState({ name: provider?.name ?? "", url: provider?.base_url ?? "", key: "", model: provider?.model ?? "" })
  const [saving, setSaving] = useState(false)
  const url = form.url.trim()
  const problem = !form.name.trim()
    ? t("models.nameRequired")
    : !isGatewayUrl(url)
      ? t("gateway.urlInvalid")
      : !provider && !form.key.trim()
        ? t("gateway.keyRequired")
        : null

  const submit = async () => {
    if (problem) {
      toast.error(problem)
      return
    }
    setSaving(true)
    await save({
      ...(provider ? { provider_id: provider.id } : {}),
      name: form.name.trim(),
      base_url: url,
      ...(form.key.trim() ? { api_key: form.key.trim() } : {}),
      model: form.model.trim(),
    })
    setSaving(false)
  }

  const field = (id: string, label: string, input: React.ReactNode) => (
    <div className="space-y-1.5">
      <label className="text-sm text-foreground" htmlFor={id}>
        {label}
      </label>
      {input}
    </div>
  )

  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{provider ? t("models.editTitle") : t("models.addTitle")}</DialogTitle>
          <DialogDescription>{t("models.dialogDesc")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {field("provider-name", t("models.name"), <Input id="provider-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} maxLength={128} autoComplete="off" autoFocus />)}
          {field(
            "provider-url",
            t("gateway.url"),
            <Input id="provider-url" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://api.example.com" className="font-mono text-sm" spellCheck={false} autoComplete="off" />
          )}
          {field(
            "provider-key",
            "API Key",
            <Input
              id="provider-key"
              type="password"
              value={form.key}
              onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
              placeholder={provider?.has_key ? t("gateway.keySaved") : undefined}
              className="font-mono text-sm"
              autoComplete="new-password"
            />
          )}
          {field(
            "provider-model",
            t("gateway.modelOptional"),
            <Input id="provider-model" value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} className="font-mono text-sm" spellCheck={false} autoComplete="off" />
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <LoaderCircleIcon className="size-3.5 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
