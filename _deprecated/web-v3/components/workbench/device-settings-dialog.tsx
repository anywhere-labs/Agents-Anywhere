"use client"

// A device's settings (the gear on its page), in the split dialog settings use: 通用 (its name, what it is, deleting it),
// 权限 (MCP, on normal devices) and 加密 (how this client reaches it: an encrypted device and its pairing, this browser's
// pinned key, the clients paired with it; a normal device says it is not encrypted and how to turn that on).
import { useCallback, useEffect, useState } from "react"
import { LockIcon, LockOpenIcon, ShieldIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { CopyableValue } from "@/components/console/copyable-value"
import { DetailList, type DetailItem } from "@/components/console/detail-list"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Card, Group, Note, Row } from "@/components/workbench/settings-parts"
import { SplitDialog, type SplitSection } from "@/components/workbench/split-dialog"
import { isDesktopApp } from "@/lib/platform/desktop"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { DeviceRecord, DeviceSettings, PairedClientEntry } from "@/lib/types/v3"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">
export type DeviceSection = "general" | "permissions" | "encryption"

export function DeviceSettingsDialog({
  open,
  onOpenChange,
  section,
  onSection,
  name,
  tunnelManager,
  device,
  encrypted,
  trust,
  fingerprint,
  settings,
  details,
  onRename,
  onSettings,
  onPair,
  onUnpin,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  section: DeviceSection | null
  onSection: (section: DeviceSection | null) => void
  name: string
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  encrypted: boolean
  /** This browser's pinned key of the device (paired). */
  trust: { device_pub: string } | null
  fingerprint: string | null
  settings: DeviceSettings | null
  details: DetailItem[]
  onRename: (name: string) => Promise<void>
  onSettings: (settings: DeviceSettings) => void
  onPair: () => void
  onUnpin: () => Promise<void>
  onDelete: () => void
}) {
  const { t, locale } = useI18n()
  const online = device?.presence === "online"
  const [draftName, setDraftName] = useState(name)
  const [unpinOpen, setUnpinOpen] = useState(false)
  const [pairedClients, setPairedClients] = useState<PairedClientEntry[]>([])
  const [code, setCode] = useState<{ code: string; fingerprint: string; expires_at: string } | null>(null)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setDraftName(name)
      setCode(null)
    }
  }

  const sections: SplitSection<DeviceSection>[] = [
    { id: "general", label: t("settings.nav.general"), Icon: SlidersHorizontalIcon },
    ...(!encrypted && settings ? [{ id: "permissions" as const, label: t("device.permissions"), Icon: ShieldIcon }] : []),
    { id: "encryption", label: t("settings.nav.encryption"), Icon: encrypted ? LockIcon : LockOpenIcon },
  ]
  const shown = (sections.find((s) => s.id === section) ?? sections[0]).id

  const call = async (task: () => Promise<unknown>, ok?: string) => {
    try {
      await task()
      if (ok) toast.success(ok)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const loadPaired = useCallback(async () => {
    if (!tunnelManager || !device || !online || !encrypted || !trust) return
    const paired = await tunnelManager.listPairedClients(device).catch(() => ({ clients: [] }))
    setPairedClients(paired.clients)
  }, [device, encrypted, online, trust, tunnelManager])

  useEffect(() => {
    if (!open || shown !== "encryption") return
    let alive = true
    queueMicrotask(() => {
      if (alive) void loadPaired()
    })
    return () => {
      alive = false
    }
  }, [loadPaired, open, shown])

  const saveName = () => {
    const next = draftName.trim()
    if (!next || next === name) {
      setDraftName(name)
      return
    }
    void call(() => onRename(next), t("common.saved"))
  }

  const desktop = isDesktopApp()

  return (
    <>
      <SplitDialog
        open={open}
        onOpenChange={onOpenChange}
        title={name}
        description={t("device.settingsDesc", { name })}
        sections={sections}
        section={section}
        onSection={onSection}
      >
        <div className="space-y-6">
          {shown === "general" && (
            <>
              <Group>
                <Card>
                  <div className="space-y-1.5 py-3">
                    <label className="text-sm text-foreground" htmlFor="device-name">
                      {t("devices.deviceName")}
                    </label>
                    <Input
                      id="device-name"
                      value={draftName}
                      maxLength={128}
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={saveName}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur()
                      }}
                      autoComplete="off"
                    />
                  </div>
                </Card>
              </Group>
              <Group title={t("device.info")}>
                <div className="rounded-2xl bg-card px-4 py-3">
                  <DetailList items={details} />
                </div>
              </Group>
              <Group>
                <Card>
                  <Row label={t("device.delete")} hint={t("devices.deleteConfirmDesc")}>
                    <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete}>
                      <Trash2Icon className="size-3.5" />
                      {t("common.delete")}
                    </Button>
                  </Row>
                </Card>
              </Group>
            </>
          )}

          {shown === "permissions" && settings && (
            <Group>
              <Card>
                <Row label={t("devices.allowMcp")} hint={t("devices.allowMcpDesc")}>
                  <Switch
                    checked={settings.allow_mcp}
                    disabled={!online}
                    aria-label={t("devices.allowMcp")}
                    onCheckedChange={(checked) =>
                      void call(async () => {
                        if (!tunnelManager || !device) return
                        onSettings(await tunnelManager.updateDeviceSettings(device, { allow_mcp: Boolean(checked) }))
                      }, t("common.saved"))
                    }
                  />
                </Row>
              </Card>
            </Group>
          )}

          {shown === "encryption" && !encrypted && (
            <Group description={t("e2ee.offDesc")}>
              <Card>
                <Row label={t("e2ee.offTitle")} hint={t("e2ee.offHow")} />
              </Card>
            </Group>
          )}

          {shown === "encryption" && encrypted && (
            <>
              <Group description={t(desktop ? "devices.greenLockDesc" : "devices.greyLockDesc")}>
                <Card>
                  <Row
                    label={trust ? t("e2ee.paired") : t("devices.unpaired")}
                    hint={trust ? t("e2ee.pairedHint") : t("devices.unpairedHint")}
                  >
                    <Button variant={trust ? "outline" : "default"} size="sm" onClick={onPair}>
                      {trust ? t("e2ee.pairAgain") : t("e2ee.pair")}
                    </Button>
                  </Row>
                  {trust && (
                    <div className="py-3">
                      <CopyableValue
                        label={t("devices.pairFingerprint")}
                        value={fingerprint ?? trust.device_pub}
                        copyLabel={t("common.copy")}
                        copyFailedLabel={t("common.copyFailed")}
                      />
                    </div>
                  )}
                  {trust && (
                    <Row label={t("device.removePin")} hint={t("e2ee.removePinHint")}>
                      <Button variant="outline" size="sm" onClick={() => setUnpinOpen(true)}>
                        {t("common.delete")}
                      </Button>
                    </Row>
                  )}
                </Card>
              </Group>

              {trust && (
                <Group
                  title={t("devices.pairedClients")}
                  action={
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground"
                      disabled={!online}
                      onClick={() =>
                        void call(async () => {
                          if (!tunnelManager || !device) return
                          const res = await tunnelManager.createPairing(device, { kind: "code" })
                          setCode({ code: res.code ?? "", fingerprint: res.fingerprint ?? "", expires_at: res.expires_at })
                        })
                      }
                    >
                      {t("devices.createPairingLink")}
                    </Button>
                  }
                >
                  {code && (
                    <div className="space-y-2 rounded-2xl bg-card px-4 py-3">
                      <CopyableValue
                        label={t("devices.generatedCodeLabel", {
                          time: new Date(code.expires_at).toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : "en-US"),
                        })}
                        value={code.code}
                        copyLabel={t("common.copy")}
                        copyFailedLabel={t("common.copyFailed")}
                      />
                      {code.fingerprint && (
                        <p className="text-xs text-muted-foreground">
                          {t("devices.pairFingerprint")}: <span className="font-mono">{code.fingerprint}</span>
                        </p>
                      )}
                    </div>
                  )}
                  <Card>
                    {pairedClients.length === 0 ? (
                      <Note>{t("devices.noPairedClients")}</Note>
                    ) : (
                      pairedClients.map((client) => (
                        <Row key={client.client_pub} label={client.label || client.platform} hint={client.client_pub}>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!online}
                            onClick={() =>
                              void call(async () => {
                                if (!tunnelManager || !device) return
                                await tunnelManager.revokePairedClient(device, client.client_pub)
                                setPairedClients((prev) => prev.filter((c) => c.client_pub !== client.client_pub))
                              }, t("common.saved"))
                            }
                          >
                            {t("e2ee.revoke")}
                          </Button>
                        </Row>
                      ))
                    )}
                  </Card>
                </Group>
              )}
            </>
          )}
        </div>
      </SplitDialog>

      <ConfirmDialog
        open={unpinOpen}
        onOpenChange={setUnpinOpen}
        title={t("device.removePin")}
        description={t("e2ee.removePinHint")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={async () => {
          await onUnpin()
          setUnpinOpen(false)
          toast.success(t("common.saved"))
        }}
      />
    </>
  )
}
