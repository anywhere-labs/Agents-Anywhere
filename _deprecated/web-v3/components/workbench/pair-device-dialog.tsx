"use client"

import { useEffect, useMemo, useState } from "react"
import { LockIcon } from "lucide-react"
import { toast } from "sonner"

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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { MessageKey } from "@/lib/i18n"
import {
  formatKeyFingerprint,
  formatPairingCode,
  isPairingUriInput,
  normalizePairingCode,
  PairingError,
  parsePairingUri,
} from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"

const PAIRING_ERROR_KEYS: Partial<Record<string, MessageKey>> = {
  invalid_pairing_code: "devices.pairError.invalidCode",
  invalid_pairing_uri: "devices.pairError.invalidLink",
  e2e_handshake_failed: "devices.pairError.handshake",
  pairing_expired: "devices.pairError.expired",
  pairing_used: "devices.pairError.used",
  device_pub_mismatch: "devices.pairError.keyMismatch",
  device_offline: "devices.pairError.noKey",
}

/**
 * Pair this browser with an encrypted device: type the pairing code the device shows (`aa-connector pair`), or
 * paste its one-time `aa-pair://v1/` link. With a code the device key comes from the control plane and is pinned
 * only after the PSK handshake succeeds (docs/_deprecated/v3/e2ee-admission-proposal.md §4.1).
 */
export function PairDeviceDialog({
  open,
  onOpenChange,
  deviceNameHint,
  deviceId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  deviceNameHint?: string
  /** The device to pair, when the dialog is opened from that device; otherwise the user picks one. */
  deviceId?: string
}) {
  const { t } = useI18n()
  const { devices, deviceTrusts, pairEncryptedDevice, pairEncryptedDeviceWithCode } = useWorkbench()

  const [input, setInput] = useState("")
  const [pickedDeviceId, setPickedDeviceId] = useState<string | null>(null)
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const encryptedDevices = useMemo(() => devices.filter((d) => d.mode_hint === "encrypted"), [devices])
  const fallbackDeviceId =
    encryptedDevices.find((d) => d.presence === "online" && !deviceTrusts[d.id])?.id ??
    encryptedDevices.find((d) => d.presence === "online")?.id ??
    encryptedDevices[0]?.id ??
    null
  const targetId = deviceId ?? pickedDeviceId ?? fallbackDeviceId
  const target = devices.find((d) => d.id === targetId) ?? null

  const isLink = isPairingUriInput(input)
  const code = isLink ? null : normalizePairingCode(input)

  const { link, linkError } = useMemo(() => {
    if (!isLink) return { link: null, linkError: null }
    try {
      return { link: parsePairingUri(input), linkError: null }
    } catch (err) {
      return { link: null, linkError: describeError(err) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, isLink])

  function describeError(err: unknown): string {
    if (err instanceof PairingError) {
      const key = PAIRING_ERROR_KEYS[err.code]
      if (key) return t(key)
    }
    return err instanceof Error ? err.message : String(err)
  }

  // The key that will be used: the link's own, or the control plane's hint for a typed code.
  const keyToShow = link?.device_pub ?? (code ? target?.e2e_public_key_hint ?? null : null)
  useEffect(() => {
    if (!keyToShow || fingerprints[keyToShow]) return
    let alive = true
    void formatKeyFingerprint(keyToShow).then((fp) => {
      if (alive) setFingerprints((prev) => ({ ...prev, [keyToShow]: fp }))
    })
    return () => {
      alive = false
    }
  }, [keyToShow, fingerprints])
  const fingerprint = keyToShow ? fingerprints[keyToShow] ?? null : null

  const typedSomething = input.trim().length > 0
  const codeError = !isLink && typedSomething && !code && input.replace(/[\s-]/g, "").length >= 10
    ? t("devices.pairError.invalidCode")
    : null
  const canSubmit = !submitting && (link !== null || (code !== null && target !== null && Boolean(target.e2e_public_key_hint)))

  const reset = () => {
    setInput("")
    setPickedDeviceId(null)
  }

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      if (link) {
        await pairEncryptedDevice(input, deviceNameHint)
      } else if (code && target) {
        await pairEncryptedDeviceWithCode(target.id, code)
      }
      toast.success(fingerprint ? t("devices.pairSuccessFingerprint", { fingerprint }) : t("devices.pairSuccess"))
      reset()
      onOpenChange(false)
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("devices.pair")}</DialogTitle>
          <DialogDescription>{t("devices.pairDesc")}</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
        >
          <Field
            label={t("devices.pairInputLabel")}
            htmlFor="pair-code"
            hint={isLink ? t("devices.pairLinkDetected") : t("devices.pairCodeHint")}
            error={linkError ?? codeError ?? undefined}
          >
            <Input
              id="pair-code"
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="font-mono tracking-wider"
              placeholder={t("devices.pairInputPlaceholder")}
              value={input}
              onChange={(e) => setInput(isPairingUriInput(e.target.value) ? e.target.value : e.target.value.toUpperCase())}
              onBlur={() => {
                if (code) setInput(formatPairingCode(code))
              }}
            />
          </Field>

          {!isLink && !deviceId && (
            <Field label={t("devices.pairDeviceLabel")}>
              {encryptedDevices.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("devices.pairNoEncryptedDevices")}</p>
              ) : (
                <RadioGroup
                  value={targetId ?? undefined}
                  onValueChange={(value) => setPickedDeviceId(String(value))}
                  className="gap-2"
                >
                  {encryptedDevices.map((d) => (
                    <label
                      key={d.id}
                      className="flex cursor-pointer items-center gap-3 rounded-xl bg-surface-raised px-3.5 py-2.5 text-sm"
                    >
                      <RadioGroupItem value={d.id} />
                      <span className="min-w-0 flex-1 truncate">{d.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {deviceTrusts[d.id]
                          ? t("devices.pairAlreadyPaired")
                          : d.presence === "online"
                            ? t("devices.pairOnline")
                            : t("devices.pairOffline")}
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              )}
            </Field>
          )}

          {(link || (code && target)) && (
            <div className="space-y-2 rounded-xl bg-background p-4 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{t("devices.pairDevice")}</span>
                <span className="truncate font-mono text-foreground">
                  {link ? link.instance_id : target?.name ?? target?.id}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{t("devices.pairFingerprint")}</span>
                <span className="font-mono text-foreground">
                  {keyToShow ? fingerprint ?? "…" : t("devices.pairError.noKey")}
                </span>
              </div>
              {code && <p className="pt-1 text-muted-foreground">{t("devices.pairCodeKeyNote")}</p>}
              <div className="flex items-start gap-2 pt-1 text-muted-foreground">
                <LockIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{t("devices.greyLockDesc")}</span>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? t("devices.pairing") : t("devices.pairConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
