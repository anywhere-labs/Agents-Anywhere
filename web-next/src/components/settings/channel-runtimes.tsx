"use client"

import * as React from "react"
import { RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { SettingsSection } from "@/components/settings/settings-section"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type {
  ChannelRuntimeState,
  DeviceRuntimeView,
  ModelChannel,
  ModelChannelState,
  ModelConfigOverview,
} from "@/features/dashboard/types"
import { modelConfigApi } from "@/features/model-config/api"
import {
  NATIVE_CHANNEL,
  TOKENS_CHANNEL,
  channelDevices,
  channelProgress,
  channelRows,
  switchFailed,
  type ChannelProgress,
} from "@/features/model-config/channel"
import { cn } from "@/lib/utils"

type Translate = ReturnType<typeof useTranslations<"pages.settings.modelConfigs">>
type ConnectorView = { id: string; name: string; status?: "online" | "offline" }
export type ChannelChoice = { value: ModelChannel; label: string }

/**
 * Channels the user can pick: the device's own configuration, Anywhere once
 * linked, and every active manual profile. A channel still chosen but no
 * longer offered stays listed so the select shows what is in effect.
 */
export function channelChoices(overview: ModelConfigOverview, t: Translate, keep: (ModelChannel | null | undefined)[] = []): ChannelChoice[] {
  const choices: ChannelChoice[] = [{ value: NATIVE_CHANNEL, label: t("current.native") }]
  if (overview.tokens?.available && overview.tokens.link?.status === "linked") {
    choices.push({ value: TOKENS_CHANNEL, label: t("channels.anywhere") })
  }
  for (const profile of overview.profiles) {
    if (profile.source === "manual" && profile.state === "active") choices.push({ value: profile.id, label: profile.name })
  }
  for (const value of keep) {
    if (value && !choices.some((choice) => choice.value === value)) {
      choices.push({ value, label: channelLabel(overview, value, t) })
    }
  }
  return choices
}

export function channelLabel(overview: ModelConfigOverview, value: ModelChannel, t: Translate): string {
  if (value === NATIVE_CHANNEL) return t("current.native")
  if (value === TOKENS_CHANNEL) return t("channels.anywhere")
  return overview.profiles.find((profile) => profile.id === value)?.name ?? value
}

/** What a write returned, unless the snapshot already moved past it. */
export function useChannelState(overview: ModelConfigOverview) {
  const [local, setLocal] = React.useState<ModelChannelState | null>(null)
  const snapshot = overview.channel ?? null
  const channel = local && (!snapshot || local.revision > snapshot.revision) ? local : snapshot
  const accept = React.useCallback((next: unknown) => {
    if (next && typeof next === "object" && Array.isArray((next as ModelChannelState).runtimes)) setLocal(next as ModelChannelState)
  }, [])
  return { channel, accept }
}

/**
 * The runtimes that should use one channel, by device, each with how far it
 * got switching to it and the channel it uses meanwhile.
 */
export function ChannelRuntimes({
  token,
  overview,
  channel,
  channelId,
  connectors,
  runtimes,
  errorText,
  onAccepted,
  onChanged,
}: {
  token: string
  overview: ModelConfigOverview
  channel: ModelChannelState | null
  channelId: ModelChannel
  connectors: ConnectorView[]
  runtimes: DeviceRuntimeView[]
  errorText: (error: unknown) => string
  onAccepted: (state: unknown) => void
  onChanged: () => void
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [busy, setBusy] = React.useState<string | null>(null)
  const rows = channelRows(channel, channelId)
  const progress = channelProgress({ runtimes: rows })
  const { devices, unsupported } = channelDevices({ runtimes: rows }, connectors)

  const run = async (key: string, action: () => Promise<ModelChannelState>) => {
    setBusy(key)
    try {
      onAccepted(await action())
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  const runtimeOf = (row: ChannelRuntimeState) =>
    runtimes.find((item) => item.connectorId === row.connectorId && item.runtimeId === row.runtimeId) ?? null
  const runtimeName = (row: ChannelRuntimeState) => {
    const runtime = runtimeOf(row)
    return runtime?.name ?? runtime?.displayName ?? row.runtimeId
  }
  const deviceName = (connectorId: string) => connectors.find((item) => item.id === connectorId)?.name ?? connectorId

  const rowProps = (row: ChannelRuntimeState) => ({
    row,
    name: runtimeName(row),
    channelName: (value: ModelChannel) => channelLabel(overview, value, t),
    fixedChannel: channelId,
    busy: busy !== null,
    working: busy === rowKey(row),
    onRetry: () => void run(rowKey(row), () => modelConfigApi.retryChannel(token, row)),
  })

  return (
    <SettingsSection
      variant="plain"
      title={t("runtimes.title")}
      description={rows.length ? <StatusText progress={progress} /> : t("status.none")}
      action={progress.phase === "attention" ? (
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run("retry", () => modelConfigApi.retryChannel(token))}>
          {busy === "retry" ? <Spinner /> : <RefreshCw data-icon="inline-start" />}{t("retry")}
        </Button>
      ) : null}
    >
      {rows.length ? (
        <div className="flex flex-col gap-4">
          {progress.phase === "running" ? (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.applied}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(progress.applied / progress.total) * 100}%` }} />
            </div>
          ) : null}
          {devices.map((device) => {
            const online = device.connector?.status ? device.connector.status === "online" : null
            const name = device.connector?.name ?? device.connectorId
            return (
              <div key={device.connectorId} data-device={device.connectorId} className="flex flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-2 px-1 text-xs">
                  <span
                    aria-label={online === null ? undefined : t(online ? "details.online" : "details.offline")}
                    className={cn("size-2 shrink-0 rounded-full", online ? "bg-emerald-500" : "bg-muted-foreground/40")}
                  />
                  <span className="min-w-0 truncate font-medium" title={name}>{name}</span>
                </div>
                <div className="flex flex-col divide-y divide-border">
                  {device.rows.map((row) => <RuntimeRow key={rowKey(row)} {...rowProps(row)} />)}
                </div>
              </div>
            )
          })}
          {/* Runtimes that cannot switch stay in view, after the ones that can. */}
          {unsupported.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="px-1 text-xs text-muted-foreground">{t("details.unsupported", { count: unsupported.length })}</span>
              <div className="flex flex-col divide-y divide-border">
                {unsupported.map((row) => <RuntimeRow key={rowKey(row)} device={deviceName(row.connectorId)} {...rowProps(row)} />)}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  )
}

function StatusText({ progress }: { progress: ChannelProgress }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const waiting = [
    progress.offlineDevices ? t("status.waitingOnline", { count: progress.offlineDevices }) : null,
  ]
  const headline = progress.phase === "none"
    ? t("details.unsupported", { count: progress.unsupported })
    : progress.phase === "done"
      ? t("status.done", { count: progress.total })
      : progress.phase === "running"
        ? t("status.running", { applied: progress.applied, total: progress.total })
        : t("status.attention", { applied: progress.applied, total: progress.total })
  const notes = (progress.phase === "attention"
    ? [
      progress.restored ? t("status.restored", { count: progress.restored }) : null,
      progress.failed ? t("status.failed", { count: progress.failed }) : null,
      ...waiting,
    ]
    : progress.phase === "running" ? waiting : []).filter(Boolean)
  return (
    <span role="status" className={cn(progress.phase === "attention" && "text-amber-700 dark:text-amber-400")}>
      {[headline, ...notes].join(" · ")}
    </span>
  )
}

/** Beside a channel in the list: how many runtimes should use it, and whether they got there. */
export function ChannelMark({ channel, channelId }: { channel: ModelChannelState | null; channelId: ModelChannel }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const progress = channelProgress({ runtimes: channelRows(channel, channelId) })
  if (progress.phase === "none") return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums" title={t("runtimes.count", { count: progress.total })}>
      {progress.phase === "running" ? <Spinner className="size-3" aria-label={t("runtimes.switching")} /> : null}
      {progress.phase === "attention" ? <span role="img" aria-label={t("runtimes.attention")} className="size-2 rounded-full bg-amber-500" /> : null}
      {progress.total}
    </span>
  )
}

const rowKey = (row: { connectorId: string; runtimeId: string }) => `${row.connectorId}/${row.runtimeId}`

export function runtimeStateText(row: ChannelRuntimeState, t: Translate): string {
  if (row.state === "switching" && row.step) return `${t("state.switching")} · ${t(`step.${row.step}`)}`
  return t(`state.${row.state}`)
}

export function reasonText(row: ChannelRuntimeState, t: Translate): string | null {
  if (row.state !== "unsupported" && !switchFailed(row)) return null
  if (!row.reason) return null
  return t.has(`reason.${row.reason}`) ? t(`reason.${row.reason}`) : t("reason.unknown")
}

function RuntimeRow({
  row,
  name,
  device,
  channelName,
  fixedChannel,
  busy,
  working,
  onRetry,
}: {
  row: ChannelRuntimeState
  name: string
  device?: string
  channelName: (value: ModelChannel) => string
  fixedChannel: ModelChannel
  busy: boolean
  working: boolean
  onRetry: () => void
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const reason = reasonText(row, t)
  const failed = switchFailed(row)
  return (
    <div data-runtime={rowKey(row)} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 text-sm">
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="truncate font-medium" title={name}>
          {name}{device ? <span className="font-normal text-muted-foreground"> · {device}</span> : null}
        </span>
        <span className={cn("text-xs text-muted-foreground", failed && "text-amber-700 dark:text-amber-400")} title={row.message ?? undefined}>
          {[runtimeStateText(row, t), reason, row.state !== "applied" ? t("details.using", { name: channelName(row.actual) }) : null]
            .filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {working ? <Spinner /> : null}
        {failed ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>
            <RefreshCw data-icon="inline-start" />{t("retry")}
          </Button>
        ) : null}
        <span className="text-sm text-muted-foreground">{channelName(fixedChannel)}</span>
      </div>
    </div>
  )
}
