"use client"

// Settings → Agent collaboration: the account switch, the cross-device switch and, per runtime instance that can host
// the collaboration tools, its own switch and the authority its Agent gets. The Server owns these settings.

import * as React from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { SettingsSection } from "@/components/settings/settings-section"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { collabApi } from "@/features/collab/api"
import {
  AUTHORITY_KEYS,
  hostsAgentTools,
  instanceSettingsOf,
  withInstanceSettings,
  type CollabSettings,
} from "@/features/collab/model"
import { dashboardApi } from "@/features/dashboard/api"
import type { ConnectorView, DeviceRuntimeView } from "@/features/dashboard/types"

type HostRow = { runtime: DeviceRuntimeView; deviceName: string; online: boolean }
type DeviceSummary = Pick<ConnectorView, "id" | "name" | "status">

/** Runtime instances whose capability set says they host the collaboration tools (never decided by provider name). */
function useAgentToolHosts(token: string, runtimes: readonly DeviceRuntimeView[], connectors: readonly DeviceSummary[]) {
  const [hosts, setHosts] = React.useState<Set<string> | null>(null)
  const targets = React.useMemo(
    () => runtimes.filter((runtime) => runtime.present !== false).map((runtime) => ({ connectorId: runtime.connectorId, runtimeId: runtime.runtimeId })),
    [runtimes],
  )
  const targetsKey = targets.map((target) => `${target.connectorId}/${target.runtimeId}`).join(",")
  const onlineKey = connectors.map((connector) => `${connector.id}:${connector.status}`).join(",")
  React.useEffect(() => {
    if (!token) return
    let cancelled = false
    void Promise.allSettled(
      targets.map(async (target) => {
        const response = await dashboardApi.getConnectorRuntimeCapabilities(token, target.connectorId, target.runtimeId)
        return hostsAgentTools(response.capabilitySet, target.runtimeId) ? target.runtimeId : null
      }),
    ).then((results) => {
      if (cancelled) return
      const next = new Set<string>()
      for (const result of results) if (result.status === "fulfilled" && result.value) next.add(result.value)
      setHosts(next)
    })
    return () => {
      cancelled = true
    }
    // targetsKey and onlineKey stand in for the arrays they describe.
  }, [token, targetsKey, onlineKey])
  return hosts
}

export function AgentCollaborationTab({
  token,
  connectors,
  runtimes,
}: {
  token: string
  connectors: DeviceSummary[]
  runtimes: DeviceRuntimeView[]
}) {
  const t = useTranslations("collab.settings")
  const tCollab = useTranslations("collab")
  const [settings, setSettings] = React.useState<CollabSettings | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const hosts = useAgentToolHosts(token, runtimes, connectors)

  React.useEffect(() => {
    if (!token) return
    let cancelled = false
    collabApi.getSettings(token).then(
      (next) => !cancelled && setSettings(next),
      (error) => !cancelled && setLoadError(error instanceof Error ? error.message : String(error)),
    )
    return () => {
      cancelled = true
    }
  }, [token])

  const save = React.useCallback(async (next: CollabSettings) => {
    const previous = settings
    setSettings(next)
    setSaving(true)
    try {
      setSettings(await collabApi.putSettings(token, next))
    } catch (error) {
      setSettings(previous)
      toast.error(t("saveFailed", { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setSaving(false)
    }
  }, [settings, t, token])

  const rows = React.useMemo<HostRow[]>(() => {
    if (!settings) return []
    const deviceName = (connectorId: string) => connectors.find((connector) => connector.id === connectorId)?.name ?? connectorId
    const online = (connectorId: string) => connectors.find((connector) => connector.id === connectorId)?.status === "online"
    // A configured instance stays listed while its device is offline, so it can still be turned off.
    return runtimes
      .filter((runtime) => hosts?.has(runtime.runtimeId) || (settings.instances[runtime.runtimeId] && !online(runtime.connectorId)))
      .map((runtime) => ({ runtime, deviceName: deviceName(runtime.connectorId), online: online(runtime.connectorId) }))
  }, [connectors, hosts, runtimes, settings])

  if (loadError) return <SettingsSection variant="plain" title={t("title")} description={t("loadFailed", { error: loadError })} />
  if (!settings) return null

  return (
    <div className="flex flex-col gap-10" data-slot="agent-collaboration-settings">
      <SettingsSection variant="plain" title={t("title")} description={t("description")}>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="collab-enabled">{t("enabled")}</FieldLabel>
              <FieldDescription>{t("enabledDescription")}</FieldDescription>
            </FieldContent>
            <Switch id="collab-enabled" checked={settings.enabled} disabled={saving} onCheckedChange={(enabled) => void save({ ...settings, enabled })} />
          </Field>
          <Field orientation="horizontal" data-disabled={!settings.enabled || undefined}>
            <FieldContent>
              <FieldLabel htmlFor="collab-cross-device">{t("crossDevice")}</FieldLabel>
              <FieldDescription>{t("crossDeviceDescription")}</FieldDescription>
            </FieldContent>
            <Switch
              id="collab-cross-device"
              checked={settings.crossDevice}
              disabled={saving || !settings.enabled}
              onCheckedChange={(crossDevice) => void save({ ...settings, crossDevice })}
            />
          </Field>
        </FieldGroup>
      </SettingsSection>

      <SettingsSection variant="plain" title={t("instancesTitle")} description={t("instancesDescription")}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("authorityHint")}</p>
          {hosts === null ? null : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noInstances")}</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-md border">
              {rows.map(({ runtime, deviceName, online }) => {
                const instance = instanceSettingsOf(settings, runtime.runtimeId)
                const disabled = saving || !settings.enabled
                const switchId = `collab-instance-${runtime.connectorId}-${runtime.runtimeId}`
                return (
                  <li key={`${runtime.connectorId}/${runtime.runtimeId}`} className="flex flex-col gap-3 p-3" data-slot="collab-instance">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <label htmlFor={switchId} className="block truncate font-medium">{runtime.displayName || runtime.name || runtime.runtimeId}</label>
                        <div className="truncate text-xs text-muted-foreground">
                          {deviceName}{online ? "" : ` · ${t("deviceOffline")}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <label className="flex items-center gap-2">
                          {t("instanceCrossDevice")}
                          <Switch
                            size="sm"
                            checked={instance.crossDevice}
                            disabled={disabled || !settings.crossDevice || !instance.enabled}
                            onCheckedChange={(crossDevice) => void save(withInstanceSettings(settings, runtime.runtimeId, { crossDevice }))}
                          />
                        </label>
                        <label className="flex items-center gap-2">
                          {t("instanceEnabled")}
                          <Switch
                            id={switchId}
                            checked={instance.enabled}
                            disabled={disabled}
                            onCheckedChange={(enabled) => void save(withInstanceSettings(settings, runtime.runtimeId, { enabled }))}
                          />
                        </label>
                      </div>
                    </div>
                    <fieldset className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3" disabled={disabled || !instance.enabled}>
                      {AUTHORITY_KEYS.map((key) => (
                        <label key={key} className="flex items-center gap-2 text-xs">
                          <Checkbox
                            checked={instance.authority[key]}
                            disabled={disabled || !instance.enabled}
                            onCheckedChange={(value) => void save(withInstanceSettings(settings, runtime.runtimeId, { authority: { [key]: value === true } }))}
                          />
                          {tCollab(`authority.${key}`)}
                        </label>
                      ))}
                    </fieldset>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </SettingsSection>
    </div>
  )
}
