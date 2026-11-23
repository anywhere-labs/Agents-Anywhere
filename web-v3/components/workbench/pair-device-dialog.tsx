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
import { Textarea } from "@/components/ui/textarea"
import { formatKeyFingerprint, parsePairingUri } from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { PairingPayload } from "@/lib/types/v3"

export function PairDeviceDialog({
  open,
  onOpenChange,
  deviceNameHint,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  deviceNameHint?: string
}) {
  const { t } = useI18n()
  const { pairEncryptedDevice } = useWorkbench()

  const [uri, setUri] = useState("")
  const [fingerprintState, setFingerprintState] = useState<{ pub: string; fp: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const { parsed, parseError } = useMemo<{
    parsed: PairingPayload | null
    parseError: string | null
  }>(() => {
    if (!uri.trim()) return { parsed: null, parseError: null }
    try {
      return { parsed: parsePairingUri(uri), parseError: null }
    } catch (err) {
      return { parsed: null, parseError: err instanceof Error ? err.message : String(err) }
    }
  }, [uri])

  useEffect(() => {
    if (!parsed?.device_pub) return
    let alive = true
    const pub = parsed.device_pub
    void formatKeyFingerprint(pub).then((fp) => {
      if (alive) setFingerprintState({ pub, fp })
    })
    return () => {
      alive = false
    }
  }, [parsed?.device_pub])

  const fingerprint =
    parsed && fingerprintState?.pub === parsed.device_pub ? fingerprintState.fp : null

  const handleSubmit = async () => {
    if (!parsed) return
    setSubmitting(true)
    try {
      await pairEncryptedDevice(uri, deviceNameHint)
      toast.success(t("devices.pairSuccess"))
      setUri("")
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("devices.pair")}</DialogTitle>
          <DialogDescription>{t("devices.pairDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field
            label={t("devices.pairUriLabel")}
            error={parseError ?? undefined}
          >
            <Textarea
              rows={3}
              className="font-mono text-xs"
              placeholder={t("devices.pairUriPlaceholder")}
              value={uri}
              onChange={(e) => setUri(e.target.value)}
            />
          </Field>

          {parsed && (
            <div className="rounded-xl bg-background p-4 text-xs space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Device ID</span>
                <span className="font-mono text-foreground">{parsed.instance_id}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{t("devices.pairFingerprint")}</span>
                <span className="font-mono text-foreground">{fingerprint ?? "…"}</span>
              </div>
              <div className="flex items-start gap-2 pt-1 text-muted-foreground">
                <LockIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{t("devices.greyLockDesc")}</span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!parsed || submitting} onClick={handleSubmit}>
            {submitting ? t("common.loading") : t("devices.pairConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
