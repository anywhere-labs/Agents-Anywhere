"use client"

// Pair this client with a device for end-to-end encryption (docs/v3/11-e2ee-noise.md §7.1). The device shows a
// QR code and an `aa-pair://` link; on a computer the link is pasted here. The person compares the device
// fingerprint shown here with the one on the device before pairing.

import * as React from "react"
import { Loader2, ShieldCheck } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useOptionalWorkspace } from "@/components/workspace-context"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { MobileConnectionContent } from "@/components/pages/mobile-signin-panel"
import type { StoredSession } from "@/features/auth/types"
import { Textarea } from "@/components/ui/textarea"
import { e2eeRuntime } from "@/features/e2ee/runtime"
import { fromB64url } from "@/lib/e2ee/bytes"
import { parsePairingUri, type PairingPayload } from "@/lib/e2ee/content-channel"
import { identityFingerprint } from "@/lib/e2ee/formats"
import { runtimeFailureOf, useRuntimeErrorText } from "@/lib/runtime-error-text"

type Parsed = { payload: PairingPayload; fingerprint: string; expired: boolean }

/** The device's name when this workspace knows it, otherwise its id. */
export function useDeviceName(): (deviceId: string | null | undefined) => string {
  const connectors = useOptionalWorkspace()?.connectors
  return React.useCallback(
    (deviceId) => (deviceId ? connectors?.find((connector) => connector.id === deviceId)?.name || deviceId : ""),
    [connectors],
  )
}

export function SecurePairingDialog({
  open,
  onOpenChange,
  deviceHint,
  session,
  onPaired,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Device the user was trying to reach, shown as context. */
  session?: StoredSession | null
  deviceHint?: string | null
  onPaired?: (deviceId: string) => void
}) {
  const t = useTranslations("e2ee.pairing")
  const errorText = useRuntimeErrorText()
  const deviceName = useDeviceName()
  const [now, setNow] = React.useState(() => Date.now())
  const [text, setText] = React.useState("")
  const [parsed, setParsed] = React.useState<Parsed | null>(null)
  const [invalid, setInvalid] = React.useState(false)
  const [pairing, setPairing] = React.useState(false)
  const [phoneVisited, setPhoneVisited] = React.useState(false)
  const [phoneBusy, setPhoneBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
      setPhoneVisited(false)
      setPhoneBusy(false)
      setText("")
      setParsed(null)
      setInvalid(false)
      setError(null)
    }
  }, [open])

  React.useEffect(() => {
    let cancelled = false
    const value = text.trim()
    setError(null)
    if (!value) {
      setParsed(null)
      setInvalid(false)
      return
    }
    try {
      const payload = parsePairingUri(value)
      void identityFingerprint(fromB64url(payload.deviceIdentityPub)).then((fingerprint) => {
        if (!cancelled) setParsed({ payload, fingerprint, expired: Date.parse(payload.expiresAt) <= Date.now() })
      })
      setInvalid(false)
    } catch {
      setParsed(null)
      setInvalid(true)
    }
    return () => {
      cancelled = true
    }
  }, [text])

  // The link expires while the dialog is open: disable pairing at that moment, not only when it was pasted.
  const expiresAt = parsed ? Date.parse(parsed.payload.expiresAt) : NaN
  React.useEffect(() => {
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(expiresAt - Date.now() + 50, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [expiresAt])
  const expired = parsed ? parsed.expired || expiresAt <= now : false

  async function pair() {
    const runtime = e2eeRuntime()
    if (!parsed || !runtime) return
    setPairing(true)
    setError(null)
    try {
      const pin = await runtime.pair(parsed.payload, deviceName(parsed.payload.deviceId))
      toast.success(t("paired", { device: deviceName(pin.deviceId) }))
      onPaired?.(pin.deviceId)
      onOpenChange(false)
    } catch (caught) {
      // Known codes read the same here as on the session page (runtimeErrors); others get a generic line.
      const failure = runtimeFailureOf(caught)
      setError(failure.code ? errorText({ code: failure.code }, t("errorGeneric")) ?? t("errorGeneric") : t("errorGeneric"))
    } finally {
      setPairing(false)
    }
  }

  const unavailable = !e2eeRuntime()

  const deviceForm = (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{deviceHint ? t("descriptionForDevice", { device: deviceName(deviceHint) }) : t("description")}</p>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="e2ee-pairing-link">{t("linkLabel")}</FieldLabel>
          <Textarea
            id="e2ee-pairing-link"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="aa-pair://…"
            rows={3}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
          />
          {invalid ? <p className="text-sm text-destructive">{t("invalidLink")}</p> : null}
        </Field>
        {parsed ? (
          <div className="rounded-md border p-3 text-sm" data-testid="e2ee-pairing-preview">
            <div className="text-muted-foreground">{t("device")}</div>
            <div className="font-medium">{deviceName(parsed.payload.deviceId)}</div>
            <div className="mt-2 text-muted-foreground">{t("fingerprint")}</div>
            <div className="font-mono" data-testid="e2ee-pairing-fingerprint">{parsed.fingerprint}</div>
            <p className="mt-2 text-muted-foreground">{t("compareHint")}</p>
            {expired ? <p className="mt-2 text-destructive">{t("errorExpired")}</p> : null}
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {unavailable ? <p className="text-sm text-destructive">{t("unsupported")}</p> : null}
      </FieldGroup>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pairing}>
          {t("cancel")}
        </Button>
        <Button onClick={() => void pair()} disabled={!parsed || expired || pairing || unavailable}>
          {pairing ? <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden /> : null}
          {t("pair")}
        </Button>
      </DialogFooter>
    </div>
  )
  const close = () => onOpenChange(false)
  const busy = pairing || phoneBusy
  const contents = session ? (
    <Tabs defaultValue={deviceHint ? "device" : "phone"} className="gap-5"
      onValueChange={(tab) => { if (tab === "phone") setPhoneVisited(true) }}>
      <TabsList>
        <TabsTrigger value="phone" disabled={busy}>{t("phoneTab")}</TabsTrigger>
        <TabsTrigger value="device" disabled={busy}>{t("deviceTab")}</TabsTrigger>
      </TabsList>
      <TabsContent value="phone" forceMount className="data-[state=inactive]:hidden">
        {open && (!deviceHint || phoneVisited) && <MobileConnectionContent directScan token={session.accessToken} userId={session.userId}
          onComplete={close} onCancel={close} onBusyChange={setPhoneBusy} />}
      </TabsContent>
      <TabsContent value="device">{deviceForm}</TabsContent>
    </Tabs>
  ) : deviceForm
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" showCloseButton={!busy} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5" aria-hidden />
            {t("title")}
          </DialogTitle>
        </DialogHeader>
        {contents}

      </DialogContent>
    </Dialog>
  )
}
