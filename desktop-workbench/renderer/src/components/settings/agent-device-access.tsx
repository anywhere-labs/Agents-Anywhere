"use client"

// Settings → Secure connections → Agent access between devices (encrypted mode). This client is paired with both
// devices, so it can vouch for one device's Agent to the other: it reads the source device's Agent identity, asks the
// target device to trust it (the target confirms locally), then hands the target's pinned key to the source device.

import * as React from "react"
import { Bot, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { SettingsSection } from "@/components/settings/settings-section"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { agentTrustApi, type AgentAccessStep } from "@/features/collab/api"
import type { PeerListResponse } from "@/generated/e2ee/v1_0/peer-list-response"
import type { DevicePin } from "@/lib/e2ee/trust-store"

type Peers = { deviceId: string; peers: PeerListResponse["peers"] | null; error: string | null }

export function AgentDeviceAccess({ pins, nameOf }: { pins: readonly DevicePin[]; nameOf: (pin: DevicePin) => string }) {
  const t = useTranslations("collab.agentAccess")
  const [sourceId, setSourceId] = React.useState(pins[0]?.deviceId ?? "")
  const [targetId, setTargetId] = React.useState(pins[1]?.deviceId ?? "")
  const [step, setStep] = React.useState<AgentAccessStep | null>(null)
  const [peers, setPeers] = React.useState<Peers | null>(null)

  // Keep both choices on paired devices, and the target different from the source.
  React.useEffect(() => {
    const known = new Set(pins.map((pin) => pin.deviceId))
    const nextSource = known.has(sourceId) ? sourceId : pins[0]?.deviceId ?? ""
    if (nextSource !== sourceId) setSourceId(nextSource)
    if (!known.has(targetId) || targetId === nextSource) {
      const nextTarget = pins.find((pin) => pin.deviceId !== nextSource)?.deviceId ?? ""
      if (nextTarget !== targetId) setTargetId(nextTarget)
    }
  }, [pins, sourceId, targetId])

  const source = pins.find((pin) => pin.deviceId === sourceId) ?? null
  const target = pins.find((pin) => pin.deviceId === targetId) ?? null
  const sourceName = source ? nameOf(source) : ""
  const targetName = target ? nameOf(target) : ""

  const loadPeers = React.useCallback(async (deviceId: string) => {
    if (!deviceId) return
    try {
      const response = await agentTrustApi.peers(deviceId)
      setPeers({ deviceId, peers: response.peers ?? [], error: null })
    } catch (error) {
      setPeers({ deviceId, peers: null, error: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  const enoughDevices = pins.length >= 2
  React.useEffect(() => {
    setPeers(null)
    if (enoughDevices) void loadPeers(sourceId)
  }, [enoughDevices, loadPeers, sourceId])

  if (pins.length === 0) return null

  const allow = async () => {
    if (!source || !target) return
    if (source.deviceId === target.deviceId) {
      toast.error(t("sameDevice"))
      return
    }
    try {
      const response = await agentTrustApi.allowAgentAccess(
        { sourceDeviceId: source.deviceId, targetDeviceId: target.deviceId, targetLabel: targetName },
        t("agentLabel", { device: sourceName }),
        setStep,
      )
      setPeers({ deviceId: source.deviceId, peers: response.peers ?? [], error: null })
      toast.success(t("done", { source: sourceName, target: targetName }))
    } catch (error) {
      toast.error(t("failed", { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setStep(null)
    }
  }

  return (
    <SettingsSection variant="plain" title={t("title")} description={t("description")}>
      {pins.length < 2 ? (
        <p className="text-sm text-muted-foreground">{t("needTwo")}</p>
      ) : (
        <div className="flex flex-col gap-4" data-slot="agent-device-access">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t("source")}</span>
              <NativeSelect value={sourceId} onChange={(event) => setSourceId(event.currentTarget.value)} disabled={step !== null}>
                {pins.map((pin) => <NativeSelectOption key={pin.deviceId} value={pin.deviceId}>{nameOf(pin)}</NativeSelectOption>)}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t("target")}</span>
              <NativeSelect value={targetId} onChange={(event) => setTargetId(event.currentTarget.value)} disabled={step !== null}>
                {pins.map((pin) => <NativeSelectOption key={pin.deviceId} value={pin.deviceId}>{nameOf(pin)}</NativeSelectOption>)}
              </NativeSelect>
            </label>
            <Button onClick={() => void allow()} disabled={step !== null || !source || !target || sourceId === targetId}>
              {step ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : <Bot data-icon="inline-start" aria-hidden />}
              {t("allowButton")}
            </Button>
          </div>
          {source && target && sourceId !== targetId ? (
            <p className="text-sm">{t("allow", { source: sourceName, target: targetName })}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("sameDevice")}</p>
          )}
          {step ? (
            <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
              {t(`step.${step}`, { source: sourceName, target: targetName })}
            </p>
          ) : null}
          {source ? (
            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium">{t("peersTitle", { device: sourceName })}</div>
              {peers?.deviceId !== source.deviceId ? null : peers.error ? (
                <p className="text-sm text-muted-foreground">{t("peersFailed", { error: peers.error })}</p>
              ) : !peers.peers || peers.peers.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("noPeers")}</p>
              ) : (
                <ul className="flex flex-col divide-y rounded-md border">
                  {peers.peers.map((peer) => {
                    const pin = pins.find((item) => item.deviceId === peer.deviceId)
                    return (
                      <li key={peer.deviceId} className="flex flex-col gap-0.5 p-3 text-sm">
                        <span className="font-medium">{pin ? nameOf(pin) : peer.label || peer.deviceId}</span>
                        <span className="font-mono text-xs text-muted-foreground">{peer.identityPubFingerprint}</span>
                        <span className="text-xs text-muted-foreground">{t("pinnedAt", { time: new Date(peer.pinnedAt).toLocaleString() })}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      )}
    </SettingsSection>
  )
}
