"use client"

import * as React from "react"
import { RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { RuntimeMaturityBadge } from "@/components/runtime-maturity-badge"
import {
  reportOperation,
  TONE_CLASS,
  useErrorText,
  useInterruptConfirm,
  useModelConfigChanged,
} from "@/components/settings/model-configs-tab"
import { SettingsSection } from "@/components/settings/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { useWorkspace } from "@/components/workspace-context"
import { dashboardApi } from "@/features/dashboard/api"
import type { DeviceRuntimeView, ModelConfigOverview, ProtocolModelCatalog } from "@/features/dashboard/types"
import { modelConfigApi, type ModelPreviewTarget } from "@/features/model-config/api"
import { assignmentStatusTone, connectionStateTone, newIdempotencyKey } from "@/features/model-config/presentation"
import {
  channelModels,
  channelsFor,
  currentChannelId,
  currentRuntimeModel,
  LOCAL_CHANNEL,
  offersLocalChannel,
  planRuntimeModelChange,
  runtimeModelEditable,
  runtimesByDevice,
  targetKey,
  withRuntimeModel,
  type RuntimeModelSetting,
} from "@/features/model-config/runtime-model"

/** Only what the page shows of a device. */
type ConnectorView = { id: string; name: string; status?: "online" | "offline" }

/** Choosing another channel restarts the runtime: confirm what the preview asks for. */
type PendingApply = { profileId: string; profileName: string; model: RuntimeModelSetting; target: ModelPreviewTarget }

export function ServiceModelsTab({ token, connectors }: { token: string; connectors: ConnectorView[] }) {
  const t = useTranslations("pages.settings.modelConfigs")
  const { modelConfig, runtimes, refreshModelConfig } = useWorkspace()
  const [loadFailed, setLoadFailed] = React.useState(false)

  const load = React.useCallback(() => {
    setLoadFailed(false)
    refreshModelConfig().catch(() => setLoadFailed(true))
  }, [refreshModelConfig])
  React.useEffect(() => {
    if (token) load()
  }, [load, token])

  if (!modelConfig) {
    return loadFailed ? (
      <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
        <span>{t("loadFailed")}</span>
        <Button size="sm" variant="outline" onClick={load}><RefreshCw data-icon="inline-start" />{t("retry")}</Button>
      </div>
    ) : <div className="flex justify-center py-10"><Spinner /></div>
  }

  const groups = runtimesByDevice(connectors, runtimes)
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t("runtimeModels.description")}</p>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("runtimeModels.empty")}</p>
      ) : groups.map(({ connector, runtimes: deviceRuntimes }) => (
        <SettingsSection
          key={connector.id}
          title={connector.name}
          description={connector.status === "offline" ? t("runtimeModels.offline") : t("runtimeModels.online")}
        >
          <div className="flex flex-col divide-y divide-border">
            {deviceRuntimes.map((runtime) => (
              <RuntimeModelRow
                key={targetKey(runtime)}
                token={token}
                runtime={runtime}
                overview={modelConfig}
                deviceOnline={connector.status !== "offline"}
              />
            ))}
          </div>
        </SettingsSection>
      ))}
    </div>
  )
}

function RuntimeModelRow({
  token,
  runtime,
  overview,
  deviceOnline,
}: {
  token: string
  runtime: DeviceRuntimeView
  overview: ModelConfigOverview
  deviceOnline: boolean
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const tStatus = useTranslations("pages.settings.modelConfigs.connectionState")
  const errorText = useErrorText()
  const changed = useModelConfigChanged()
  const interrupt = useInterruptConfirm()
  const editable = runtimeModelEditable(runtime, deviceOnline)
  const assignment = overview.assignments.find((item) => targetKey(item) === targetKey(runtime))
  const status = assignment?.modelConnectionStatus ?? runtime.modelConnectionStatus
  const channels = channelsFor(runtime, overview.profiles, t("runtimeModels.localChannel"))
  const savedChannel = currentChannelId(runtime, overview.assignments)
  const savedModel = currentRuntimeModel(runtime)
  const [channelId, setChannelId] = React.useState<string | null>(savedChannel)
  const [catalog, setCatalog] = React.useState<ProtocolModelCatalog | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [pending, setPending] = React.useState<PendingApply | null>(null)

  // A saved change (or another client's) moves the picker back to what the runtime uses.
  React.useEffect(() => { setChannelId(savedChannel) }, [savedChannel, savedModel?.modelId])

  // The runtime's own models come from its catalog; only a running instance can answer.
  const wantsCatalog = editable && offersLocalChannel(runtime)
  React.useEffect(() => {
    if (!wantsCatalog || !token) return
    let cancelled = false
    dashboardApi.getConnectorRuntimeModelCatalog(token, runtime.connectorId, runtime.runtimeId)
      .then((response) => { if (!cancelled) setCatalog(response.catalog) })
      .catch(() => { if (!cancelled) setCatalog(null) })
    return () => { cancelled = true }
  }, [wantsCatalog, token, runtime.connectorId, runtime.runtimeId])

  const channel = channels.find((item) => item.id === channelId) ?? null
  const models = channelModels(channel, runtime, overview.profiles, catalog)
  const sameChannel = channelId === savedChannel
  const modelValue = sameChannel ? savedModel?.modelId ?? "" : ""
  const channelName = (id: string | null) => channels.find((item) => item.id === id)?.name
    ?? overview.profiles.find((profile) => profile.id === id)?.name
    ?? (id === LOCAL_CHANNEL ? t("runtimeModels.localChannel") : t("notAssigned"))
  const modelName = (id: string) => models.find((item) => item.id === id)?.name ?? id

  const saveConfig = async (config: Record<string, unknown>, model: RuntimeModelSetting | null) => {
    await dashboardApi.putConnectorRuntimeConfig(token, runtime.connectorId, runtime.runtimeId, config)
    toast.success(model ? t("runtimeModels.saved", { model: modelName(model.modelId) }) : t("runtimeModels.cleared"))
  }

  const apply = async (request: PendingApply, options: { allowInterrupt: boolean; deferBusy: boolean; confirmNativeGlobal: boolean }) => {
    const operation = await modelConfigApi.apply(token, {
      profileId: request.profileId,
      targets: [{ connectorId: runtime.connectorId, runtimeId: runtime.runtimeId }],
      model: request.model,
      ...options,
    }, newIdempotencyKey())
    reportOperation(operation, t)
    changed()
  }

  const choose = async (modelId: string) => {
    if (!channel) return
    setBusy(true)
    try {
      if (!modelId) {
        // Following the runtime again only makes sense on the channel in use.
        await saveConfig(withRuntimeModel(runtime, null), null)
        return
      }
      const model: RuntimeModelSetting = { modelId }
      const change = planRuntimeModelChange(runtime, savedChannel, channel.id, model)
      if (change.kind === "save") {
        await saveConfig(change.config, model)
      } else if (change.kind === "restore-then-save") {
        if (!assignment) return
        const restored = await interrupt.run((allow) => modelConfigApi.restore(token, assignment, allow))
        if (!restored) return
        // Save on the config the restore left, never on the one this page last saw.
        const fresh = await dashboardApi.getConnectorRuntimes(token, runtime.connectorId)
        const current = fresh.runtimes.find((item) => item.runtimeId === runtime.runtimeId)
        if (current) await saveConfig(withRuntimeModel(current, model), model)
        changed()
      } else {
        const preview = await modelConfigApi.preview(token, change.profileId, [{ connectorId: runtime.connectorId, runtimeId: runtime.runtimeId }], model)
        const target = preview.targets.find((item) => targetKey(item) === targetKey(runtime))
        if (!target || target.decision !== "apply") {
          toast.error(t.has(`skip.${target?.reason}`) ? t(`skip.${target?.reason}`) : t("skip.unknown"))
          return
        }
        const request = { profileId: change.profileId, profileName: channel.name, model, target }
        const running = target.effect === "restart" ? target.runningSessions ?? 0 : 0
        if (target.requiresConfirmation || running > 0) {
          setPending(request)
          return
        }
        await apply(request, { allowInterrupt: false, deferBusy: false, confirmNativeGlobal: false })
      }
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      {interrupt.dialog}
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{runtime.name ?? runtime.displayName}</span>
          <RuntimeMaturityBadge maturity={runtime.modelConnection?.maturity ?? runtime.maturity} />
          {runtime.managedBy === "model-config" ? <Badge variant="secondary">{t("managedInstance")}</Badge> : null}
          {assignment && assignment.status !== "applied" ? (
            <Badge variant="outline" className={TONE_CLASS[assignmentStatusTone(assignment.status)]}>
              {t(`assignmentStatus.${assignment.status}`)}
            </Badge>
          ) : null}
          {status ? (
            <Badge variant="outline" className={TONE_CLASS[connectionStateTone(status.state)]}>
              {tStatus(status.state)}
            </Badge>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {editable ? t("runtimeModels.newSessionsOnly") : t("runtimeModels.readOnly")}
          {status?.reason ? ` · ${status.reason}` : ""}
        </span>
      </div>
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            size="sm"
            aria-label={t("runtimeModels.channel")}
            value={channelId ?? ""}
            disabled={busy || channels.length === 0}
            onChange={(event) => setChannelId(event.currentTarget.value || null)}
          >
            {channelId === null ? <NativeSelectOption value="">{t("runtimeModels.chooseChannel")}</NativeSelectOption> : null}
            {channels.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            size="sm"
            aria-label={t("runtimeModels.model")}
            value={modelValue}
            disabled={busy || !channel || models.length === 0}
            onChange={(event) => void choose(event.currentTarget.value)}
          >
            <NativeSelectOption value="" disabled={!sameChannel}>
              {sameChannel ? t("runtimeModels.followRuntime") : models.length ? t("runtimeModels.chooseModel") : t("runtimeModels.noModels")}
            </NativeSelectOption>
            {models.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>
            ))}
            {modelValue && !models.some((item) => item.id === modelValue) ? (
              <NativeSelectOption value={modelValue}>{modelValue}</NativeSelectOption>
            ) : null}
          </NativeSelect>
          {busy ? <Spinner /> : null}
        </div>
      ) : (
        <div className="flex flex-col items-end gap-0.5 text-sm">
          <span>{channelName(savedChannel)}</span>
          <span className="text-xs text-muted-foreground">{savedModel ? savedModel.modelId : t("runtimeModels.followRuntime")}</span>
        </div>
      )}
      {pending ? (
        <ConfirmApplyDialog
          pending={pending}
          onCancel={() => setPending(null)}
          onConfirm={async (options) => {
            const request = pending
            setPending(null)
            setBusy(true)
            try {
              await apply(request, options)
            } catch (error) {
              toast.error(errorText(error))
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : null}
    </div>
  )
}

function ConfirmApplyDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingApply
  onCancel: () => void
  onConfirm: (options: { allowInterrupt: boolean; deferBusy: boolean; confirmNativeGlobal: boolean }) => void
}) {
  const t = useTranslations("pages.settings.modelConfigs")
  const [confirmGlobal, setConfirmGlobal] = React.useState(false)
  const { target } = pending
  const running = target.effect === "restart" ? target.runningSessions ?? 0 : 0
  const blocked = Boolean(target.requiresConfirmation) && !confirmGlobal
  const confirm = (allowInterrupt: boolean, deferBusy: boolean) =>
    onConfirm({ allowInterrupt, deferBusy, confirmNativeGlobal: Boolean(target.requiresConfirmation) && confirmGlobal })
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("runtimeModels.switchTitle", { name: pending.profileName })}</DialogTitle>
          <DialogDescription>
            {running > 0 ? t("runtimeModels.busyDescription", { count: running }) : t("runtimeModels.switchDescription")}
          </DialogDescription>
        </DialogHeader>
        {target.requiresConfirmation ? (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={confirmGlobal} onCheckedChange={(checked) => setConfirmGlobal(checked === true)} />
            <span>{t("confirmNativeGlobal")}</span>
          </label>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{t("cancel")}</Button>
          {running > 0 ? (
            <>
              <Button variant="outline" disabled={blocked} onClick={() => confirm(false, true)}>{t("runtimeModels.applyWhenIdle")}</Button>
              <Button variant="destructive" disabled={blocked} onClick={() => confirm(true, false)}>{t("runtimeModels.interruptNow")}</Button>
            </>
          ) : (
            <Button disabled={blocked} onClick={() => confirm(false, false)}>{t("runtimeModels.switch")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
