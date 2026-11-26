"use client"

import { useState } from "react"
import { toast } from "sonner"

import { CopyableValue } from "@/components/console/copyable-value"
import { DropdownSelect } from "@/components/dropdown-select"
import { Field } from "@/components/field"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { registerDevice } from "@/lib/api/control-http"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { DeviceMode, DevicePlatform, RegisterDeviceResponse } from "@/lib/types/v3"

export function RegisterDeviceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const { activeAccount, getFreshAccessToken, refreshDevices } = useWorkbench()

  const [name, setName] = useState("")
  const [platform, setPlatform] = useState<DevicePlatform>("macos")
  const [mode, setMode] = useState<DeviceMode>("normal")
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<RegisterDeviceResponse | null>(null)

  const handleCreate = async () => {
    if (!activeAccount || !name.trim()) return
    setSubmitting(true)
    try {
      const token = await getFreshAccessToken()
      const res = await registerDevice(activeAccount.serverUrl, token, {
        name: name.trim(),
        platform,
        mode_hint: mode,
      })
      setCreated(res)
      void refreshDevices().catch(() => undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      setCreated(null)
      setName("")
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("devices.register")}</DialogTitle>
          <DialogDescription>{t("devices.registerDesc")}</DialogDescription>
        </DialogHeader>

        {!created ? (
          <div className="space-y-4">
            <Field label={t("devices.deviceName")} hint={t("devices.registerNotice")}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="MacBook Pro"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("devices.platform")}>
                <DropdownSelect
                  value={platform}
                  label={t("devices.platform")}
                  onChange={setPlatform}
                  options={[
                    { value: "macos", label: "macOS" },
                    { value: "linux", label: "Linux" },
                    { value: "windows", label: "Windows" },
                  ]}
                />
              </Field>
              <Field label={t("devices.mode")}>
                <DropdownSelect
                  value={mode}
                  label={t("devices.mode")}
                  onChange={setMode}
                  options={[
                    { value: "normal", label: t("devices.modeNormal") },
                    { value: "encrypted", label: t("devices.modeEncrypted") },
                  ]}
                />
              </Field>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-warning">{t("devices.secretOnce")}</p>
            <CopyableValue
              label="Device ID"
              value={created.device.id}
              copyLabel={t("common.copy")}
              copyFailedLabel={t("common.copyFailed")}
            />
            <CopyableValue
              label="Device Secret"
              value={created.device_secret}
              copyLabel={t("common.copy")}
              copyFailedLabel={t("common.copyFailed")}
            />
            <CopyableValue
              label="Connector CLI"
              value={`aa-connector --control-url ${activeAccount?.serverUrl ?? ""} --device-id ${created.device.id} --device-secret ${created.device_secret} --mode ${mode}`}
              copyLabel={t("common.copy")}
              copyFailedLabel={t("common.copyFailed")}
            />
          </div>
        )}

        <DialogFooter>
          {!created ? (
            <>
              <Button variant="outline" onClick={() => handleClose(false)}>
                {t("common.cancel")}
              </Button>
              <Button disabled={!name.trim() || submitting} onClick={handleCreate}>
                {submitting ? t("common.loading") : t("common.create")}
              </Button>
            </>
          ) : (
            <Button onClick={() => handleClose(false)}>{t("common.close")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
