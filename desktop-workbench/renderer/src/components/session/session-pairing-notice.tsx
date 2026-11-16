"use client"

import * as React from "react"
import { ShieldAlert } from "lucide-react"
import { useTranslations } from "next-intl"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { e2eeRuntime } from "@/features/e2ee/runtime"
import { requestSecurePairing } from "@/lib/e2ee/state"
import { useRuntimeErrorText } from "@/lib/runtime-error-text"
import { clearSessionPairing, sessionPairingCode, subscribeSessionPairing } from "./session-pairing"

/**
 * The session's device needs pairing before its content can be read. Unlike the
 * one-time automatic prompt, this stays above the composer and reopens the
 * pairing dialog as often as needed; once the device is paired it reloads.
 */
export function SessionPairingNotice({ sessionId, deviceId, onPaired, className = "mx-auto w-full max-w-3xl px-4 pt-2" }: { sessionId: string; deviceId: string | null; onPaired: () => void; className?: string }) {
  const tSession = useTranslations("dashboard.session")
  const runtimeErrorText = useRuntimeErrorText()
  const code = React.useSyncExternalStore(
    subscribeSessionPairing,
    () => sessionPairingCode(sessionId),
    () => null,
  )
  const onPairedRef = React.useRef(onPaired)
  onPairedRef.current = onPaired

  React.useEffect(() => {
    const runtime = e2eeRuntime()
    if (!code || !runtime) return
    let current = true
    const check = async () => {
      const pins = await runtime.store.pins()
      // Without a known device (the session never loaded), any new pairing is worth a retry.
      if (!current || (deviceId && !pins.some(pin => pin.deviceId === deviceId))) return
      clearSessionPairing(sessionId)
      onPairedRef.current()
    }
    const unsubscribe = runtime.store.onChange(() => void check())
    return () => {
      current = false
      unsubscribe()
    }
  }, [code, deviceId, sessionId])

  if (!code) return null
  return (
    <div className={className}>
      <Alert data-testid="session-pairing-required">
        <ShieldAlert />
        <AlertTitle>{tSession("pairingRequiredTitle")}</AlertTitle>
        <AlertDescription>{runtimeErrorText({ code }, tSession("pairingRequiredTitle"))}</AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={() => requestSecurePairing(deviceId)}>{tSession("pairDevice")}</Button>
        </AlertAction>
      </Alert>
    </div>
  )
}
