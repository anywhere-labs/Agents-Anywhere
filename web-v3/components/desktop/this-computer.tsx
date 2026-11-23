"use client"

// "This computer" card, shown only inside the desktop app (`desktop-v3`): status of the managed connector and
// its local Router, first-run registration of this machine with the signed-in control plane (normal or
// encrypted), and — for encrypted mode — pairing this app with its own device plus a QR code for other clients.

import { useCallback, useEffect, useState } from "react"
import { KeyRoundIcon, LaptopIcon, PlayIcon, QrCodeIcon, ScrollTextIcon, SquareIcon } from "lucide-react"
import { toast } from "sonner"

import { CopyableValue } from "@/components/console/copyable-value"
import { DropdownSelect } from "@/components/dropdown-select"
import { Field } from "@/components/field"
import { useI18n } from "@/components/i18n-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  getDesktopBridge,
  type DesktopConnectorMode,
  type DesktopConnectorStatus,
  type DesktopPairResult,
} from "@/lib/platform/desktop"
import { useWorkbench } from "@/lib/state/workbench-context"
import { cn } from "@/lib/utils"

const SELF_PAIR_LABEL = "Agents Anywhere Desktop"

export function DesktopThisComputer() {
  const bridge = getDesktopBridge()
  if (!bridge) return null
  return <ThisComputerCard />
}

function ThisComputerCard() {
  const bridge = getDesktopBridge()!
  const { t } = useI18n()
  const { activeAccount, deviceTrusts, devices, getFreshAccessToken, pairEncryptedDevice, refreshDevices } =
    useWorkbench()
  const [status, setStatus] = useState<DesktopConnectorStatus | null>(null)
  const [name, setName] = useState("")
  const [mode, setMode] = useState<DesktopConnectorMode>("normal")
  const [busy, setBusy] = useState<string | null>(null)
  const [pairing, setPairing] = useState<DesktopPairResult | null>(null)
  const [logs, setLogs] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void bridge.connector.status().then((s) => {
      if (!alive) return
      setStatus(s)
      setName((current) => current || s.deviceName || "")
    })
    const off = bridge.connector.onStatus((s) => setStatus(s))
    const timer = setInterval(() => {
      void bridge.connector.status().then((s) => alive && setStatus(s))
    }, 5_000)
    return () => {
      alive = false
      off()
      clearInterval(timer)
    }
  }, [bridge])

  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try {
      await fn()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  if (!status) return null

  const state = status.connector.state
  const running = state === "running"
  const device = status.deviceId ? devices.find((d) => d.id === status.deviceId) : undefined
  const selfPaired = status.deviceId ? Boolean(deviceTrusts[status.deviceId]) : false

  const register = () =>
    run("register", async () => {
      if (!activeAccount) return
      const accessToken = await getFreshAccessToken()
      const next = await bridge.connector.register({
        controlUrl: activeAccount.serverUrl,
        accessToken,
        name: name.trim(),
        mode,
      })
      setStatus(next)
      toast.success(t("desktop.registered"))
      await refreshDevices().catch(() => undefined)
    })

  const pairSelf = () =>
    run("pairSelf", async () => {
      const result = await bridge.connector.pair({ label: SELF_PAIR_LABEL })
      await pairEncryptedDevice(result.uri, status.deviceName ?? undefined)
      toast.success(t("desktop.selfPaired"))
    })

  const pairOther = () =>
    run("pairOther", async () => {
      setPairing(await bridge.connector.pair({ ttlSeconds: 600 }))
    })

  const toggleConnector = () =>
    run("toggle", async () => {
      setStatus(running ? await bridge.connector.stop() : await bridge.connector.start())
    })

  const toggleLogs = () =>
    run("logs", async () => {
      setLogs(logs === null ? await bridge.connector.logs(200) : null)
    })

  return (
    <section className="space-y-4 rounded-card bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <LaptopIcon className="size-5 shrink-0 stroke-[1.5] text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {t("desktop.thisComputer")}
              {status.registered && status.deviceName ? ` · ${status.deviceName}` : ""}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {status.localRouter
                ? t("desktop.localRouter", { url: status.localRouter.url })
                : t("desktop.localRouterOff")}
              {status.runtimes.length > 0 &&
                ` · ${status.runtimes.map((r) => r.name).join(", ")}`}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={running ? "secondary" : "outline"}>
            <span
              className={cn(
                "mr-1.5 inline-block size-1.5 rounded-full",
                running ? "bg-success" : state === "failed" ? "bg-destructive" : "bg-muted-foreground/40"
              )}
            />
            {t(`desktop.state.${state}`)}
          </Badge>
          {status.registered && device && (
            <Badge variant="outline">
              {device.presence === "online" ? t("devices.online") : t("devices.offline")}
            </Badge>
          )}
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={toggleConnector}>
            {running ? <SquareIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
            <span>{running ? t("desktop.stop") : t("desktop.start")}</span>
          </Button>
          <Button variant="ghost" size="sm" disabled={busy === "logs"} onClick={toggleLogs}>
            <ScrollTextIcon className="size-3.5" />
            <span>{logs === null ? t("desktop.showLogs") : t("desktop.hideLogs")}</span>
          </Button>
        </div>
      </div>

      {status.connector.lastError && state !== "running" && (
        <p className="text-xs text-destructive">{status.connector.lastError}</p>
      )}

      {!status.registered && activeAccount && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("desktop.registerDesc")}</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Field label={t("devices.deviceName")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="MacBook Pro" />
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
          {mode === "encrypted" && (
            <p className="text-xs text-muted-foreground">{t("desktop.encryptedHint")}</p>
          )}
          <Button disabled={!name.trim() || busy !== null} onClick={register}>
            {busy === "register" ? t("common.loading") : t("desktop.register")}
          </Button>
        </div>
      )}

      {status.registered && status.mode === "encrypted" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {!selfPaired && (
              <Button size="sm" disabled={busy !== null || !running} onClick={pairSelf}>
                <KeyRoundIcon className="size-3.5" />
                <span>{t("desktop.pairSelf")}</span>
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={busy !== null || !running} onClick={pairOther}>
              <QrCodeIcon className="size-3.5" />
              <span>{t("desktop.pairOther")}</span>
            </Button>
          </div>
          {pairing && (
            <div className="flex flex-wrap items-start gap-4">
              <div
                className="size-44 shrink-0 rounded-2xl bg-white p-2"
                aria-label={t("desktop.pairQr")}
                // SVG rendered locally by the desktop main process from the pairing link.
                dangerouslySetInnerHTML={{ __html: pairing.qr_svg }}
              />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t("desktop.pairOtherDesc", { time: new Date(pairing.expires_at).toLocaleTimeString() })}
                </p>
                <CopyableValue
                  label={t("desktop.pairLink")}
                  value={pairing.uri}
                  copyLabel={t("common.copy")}
                  copyFailedLabel={t("common.copyFailed")}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {logs !== null && (
        <pre className="max-h-72 overflow-auto rounded-2xl bg-muted p-3 font-mono text-xs leading-relaxed text-muted-foreground">
          {logs || t("desktop.noLogs")}
        </pre>
      )}
    </section>
  )
}
