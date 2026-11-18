"use client"

// Settings → Secure connections: this client's fingerprint, the devices it is paired with for end-to-end
// encryption, and the local "requires encryption" policy (docs/v3/11-e2ee-noise.md §3, §7).

import * as React from "react"
import { Copy, ShieldCheck, ShieldOff, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useDeviceName } from "@/components/e2ee/secure-pairing-dialog"
import { SettingsSection } from "@/components/settings/settings-section"
import { AgentDeviceAccess } from "@/components/settings/agent-device-access"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { e2eeRuntime } from "@/features/e2ee/runtime"
import { copyText } from "@/lib/clipboard"
import { requestSecurePairing, serverE2eeDeclaration } from "@/lib/e2ee/state"
import type { DevicePin, LocalPolicy } from "@/lib/e2ee/trust-store"

type View = { fingerprint: string; clientId: string; pins: DevicePin[]; policy: LocalPolicy }

export function SecureConnectionsTab() {
  const t = useTranslations("e2ee.settings")
  const [view, setView] = React.useState<View | null>(null)
  const [unavailable, setUnavailable] = React.useState(false)
  const deviceName = useDeviceName()
  const [forgetting, setForgetting] = React.useState<DevicePin | null>(null)
  const [relaxOpen, setRelaxOpen] = React.useState(false)

  const load = React.useCallback(async () => {
    const runtime = e2eeRuntime()
    if (!runtime) {
      setUnavailable(true)
      return
    }
    const [identity, pins, policy] = await Promise.all([runtime.store.identity(), runtime.store.pins(), runtime.store.policy()])
    setView({ fingerprint: identity.fingerprint, clientId: identity.clientId, pins, policy })
  }, [])

  React.useEffect(() => {
    void load()
    return e2eeRuntime()?.store.onChange(() => void load())
  }, [load])

  if (unavailable)
    return (
      <SettingsSection variant="plain" title={t("title")} description={t("unsupported")} />
    )
  if (!view) return null

  const serverRequires = serverE2eeDeclaration() === "required"

  return (
    <div className="flex flex-col gap-10">
      <SettingsSection
        variant="plain"
        title={t("title")}
        description={view.policy.required || serverRequires ? t("statusRequired") : t("statusOptional")}
        action={
          <Button onClick={() => requestSecurePairing()}>
            <ShieldCheck data-icon="inline-start" aria-hidden />
            {t("pairDevice")}
          </Button>
        }
      >
        <div className="flex flex-col gap-1 text-sm">
          <div className="text-muted-foreground">{t("thisClient")}</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono" data-testid="e2ee-client-fingerprint">{view.fingerprint}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copyText(view.fingerprint).then(() => toast.success(t("copied")), () => toast.error(t("copyFailed")))}
            >
              <Copy data-icon="inline-start" aria-hidden />
              {t("copy")}
            </Button>
          </div>
          <p className="text-muted-foreground">{t("thisClientHint")}</p>
        </div>
      </SettingsSection>

      <SettingsSection variant="plain" title={t("devicesTitle")} description={t("devicesDescription")}>
        {view.pins.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noDevices")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {view.pins.map((pin) => (
              <li key={pin.deviceId} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{deviceName(pin.deviceId) !== pin.deviceId ? deviceName(pin.deviceId) : pin.label || pin.deviceId}</div>
                  <div className="font-mono text-xs text-muted-foreground">{pin.fingerprint}</div>
                  <div className="text-xs text-muted-foreground">{t("pairedAt", { time: new Date(pin.grantedAt).toLocaleString() })}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setForgetting(pin)}>
                  <Trash2 data-icon="inline-start" aria-hidden />
                  {t("forget")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <AgentDeviceAccess
        pins={view.pins}
        nameOf={(pin) => (deviceName(pin.deviceId) !== pin.deviceId ? deviceName(pin.deviceId) : pin.label || pin.deviceId)}
      />

      {view.policy.required && !serverRequires ? (
        <SettingsSection
          variant="plain"
          title={t("policyTitle")}
          description={t("policyDescription")}
          action={
            <Button variant="outline" onClick={() => setRelaxOpen(true)}>
              <ShieldOff data-icon="inline-start" aria-hidden />
              {t("relax")}
            </Button>
          }
        />
      ) : null}

      <AlertDialog open={forgetting !== null} onOpenChange={(open) => !open && setForgetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("forgetTitle", { device: forgetting ? deviceName(forgetting.deviceId) : "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("forgetDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const pin = forgetting
                setForgetting(null)
                if (pin) void e2eeRuntime()?.store.forget(pin.deviceId).then(() => toast.success(t("forgotten")))
              }}
            >
              {t("forget")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={relaxOpen} onOpenChange={setRelaxOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("relaxTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("relaxDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void e2eeRuntime()?.store.relaxLocally()}>
              {t("relax")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
