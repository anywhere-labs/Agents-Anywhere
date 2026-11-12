"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Switch } from "@/components/ui/switch"
import { dashboardApi, type ConnectorDeviceSettings } from "@/features/dashboard/api"

/**
 * Reads and changes one device's settings on the server, which hands them to
 * the device (docs/api/device-settings.md). A change made while the device is
 * offline is kept and applied when it connects.
 */
export function useDeviceSettings(connectorId: string | null | undefined, token: string | null | undefined) {
  const t = useTranslations("dashboard.device")
  const [settings, setSettings] = React.useState<ConnectorDeviceSettings | null>(null)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  // A save started after a read must not be overwritten when that read returns.
  const generation = React.useRef(0)

  const load = React.useCallback(async () => {
    if (!connectorId || !token) return
    const current = ++generation.current
    setLoadFailed(false)
    try {
      const response = await dashboardApi.getConnectorDeviceSettings(token, connectorId)
      if (current === generation.current) setSettings(response.settings)
    } catch {
      if (current === generation.current) setLoadFailed(true)
    }
  }, [connectorId, token])

  React.useEffect(() => {
    setSettings(null)
    void load()
  }, [load])

  const update = React.useCallback(async (patch: Partial<ConnectorDeviceSettings>) => {
    if (!connectorId || !token || !settings) return
    const current = ++generation.current
    const previous = settings
    setSettings({ ...settings, ...patch })
    setSaving(true)
    try {
      const response = await dashboardApi.updateConnectorDeviceSettings(token, connectorId, patch)
      if (current === generation.current) setSettings(response.settings)
      if (response.delivered === false) toast.info(t("deviceSettingsPending"))
    } catch (error) {
      if (current === generation.current) setSettings(previous)
      toast.error(error instanceof Error && error.message ? error.message : t("deviceSettingsSaveFailed"))
    } finally {
      setSaving(false)
    }
  }, [connectorId, settings, t, token])

  return { settings, loadFailed, saving, reload: load, update }
}

export function ConfirmQuitOnShutdownSwitch({
  settings,
  disabled,
  onChange,
}: {
  settings: ConnectorDeviceSettings | null
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const t = useTranslations("dashboard.device")
  return (
    <Switch
      aria-label={t("confirmQuitOnShutdown")}
      checked={settings?.confirmQuitOnShutdown ?? false}
      disabled={disabled || !settings}
      onCheckedChange={onChange}
    />
  )
}

/** The device page's settings for a Desktop device. */
export function DeviceSettingsSection({ connectorId, token }: { connectorId: string; token: string | null | undefined }) {
  const t = useTranslations("dashboard.device")
  const { settings, loadFailed, saving, reload, update } = useDeviceSettings(connectorId, token)

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {t("deviceSettings")}
        </h2>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("confirmQuitOnShutdown")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {loadFailed ? (
              <>
                {t("deviceSettingsLoadFailed")}{" "}
                <button type="button" className="underline underline-offset-2" onClick={() => void reload()}>
                  {t("deviceSettingsRetry")}
                </button>
              </>
            ) : (
              t("confirmQuitOnShutdownDescription")
            )}
          </p>
        </div>
        <ConfirmQuitOnShutdownSwitch
          settings={settings}
          disabled={saving}
          onChange={(checked) => void update({ confirmQuitOnShutdown: checked })}
        />
      </div>
    </section>
  )
}
