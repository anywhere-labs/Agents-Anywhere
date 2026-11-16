"use client"

// Pair this client with a device for end-to-end encryption (docs/v3/11-e2ee-noise.md §7.1). The device shows a
// QR code and an `aa-pair://` link; on a computer the link is pasted here. The person compares the device
// fingerprint shown here with the one on the device before pairing.

import * as React from "react"
import { Loader2, ShieldCheck } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { e2eeRuntime } from "@/features/e2ee/runtime"
import { fromB64url } from "@/lib/e2ee/bytes"
import { parsePairingUri, type PairingPayload } from "@/lib/e2ee/client-channel"
import { identityFingerprint } from "@/lib/e2ee/formats"

type Parsed = { payload: PairingPayload; fingerprint: string; expired: boolean }

const PAIRING_ERROR_KEYS: Record<string, string> = {
  pairing_expired: "errorExpired",
  device_pin_mismatch: "errorMismatch",
  e2ee_handshake_failed: "errorHandshake",
  e2ee_protocol_error: "errorHandshake",
  connector_offline: "errorOffline",
}

export function SecurePairingDialog({
  open,
  onOpenChange,
  deviceHint,
  onPaired,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Device the user was trying to reach, shown as context. */
  deviceHint?: string | null
  onPaired?: (deviceId: string) => void
}) {
  const t = useTranslations("e2ee.pairing")
  const [text, setText] = React.useState("")
  const [parsed, setParsed] = React.useState<Parsed | null>(null)
  const [invalid, setInvalid] = React.useState(false)
  const [pairing, setPairing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
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
        if (!cancelled) setParsed({ payload, fingerprint, expired: Date.parse(payload.expiresAt) < Date.now() })
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

  async function pair() {
    const runtime = e2eeRuntime()
    if (!parsed || !runtime) return
    setPairing(true)
    setError(null)
    try {
      const pin = await runtime.pair(parsed.payload)
      toast.success(t("paired", { device: pin.deviceId }))
      onPaired?.(pin.deviceId)
      onOpenChange(false)
    } catch (caught) {
      const code = (caught as { code?: string })?.code ?? ""
      setError(t(PAIRING_ERROR_KEYS[code] ?? "errorGeneric", { code }))
    } finally {
      setPairing(false)
    }
  }

  const unavailable = !e2eeRuntime()

  return (
    <Dialog open={open} onOpenChange={(next) => !pairing && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5" aria-hidden />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{deviceHint ? t("descriptionForDevice", { device: deviceHint }) : t("description")}</DialogDescription>
        </DialogHeader>
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
              <div className="font-medium">{parsed.payload.deviceId}</div>
              <div className="mt-2 text-muted-foreground">{t("fingerprint")}</div>
              <div className="font-mono" data-testid="e2ee-pairing-fingerprint">{parsed.fingerprint}</div>
              <p className="mt-2 text-muted-foreground">{t("compareHint")}</p>
              {parsed.expired ? <p className="mt-2 text-destructive">{t("errorExpired")}</p> : null}
            </div>
          ) : null}
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          {unavailable ? <p className="text-sm text-destructive">{t("unsupported")}</p> : null}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pairing}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void pair()} disabled={!parsed || parsed.expired || pairing || unavailable}>
            {pairing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t("pair")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
