"use client"

import * as React from "react"
import QRCode from "qrcode"
import { Copy, KeyRound, ShieldCheck, ShieldOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { SettingsSection } from "@/components/settings/settings-section"
import { authApi } from "@/features/auth/api"
import type { TotpSetup, TotpStatus } from "@/features/auth/types"
import { isApiError } from "@/lib/api"

type DialogMode = "setup" | "disable" | "regenerate" | null

export function TwoFactorSection({ token }: { token: string }) {
  const t = useTranslations("pages.settings.twoFactor")
  const [status, setStatus] = React.useState<TotpStatus | null>(null)
  const [mode, setMode] = React.useState<DialogMode>(null)

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await authApi.totpStatus(token))
    } catch {
      setStatus(null)
    }
  }, [token])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const enabled = Boolean(status?.enabled)

  return (
    <>
      <SettingsSection
        title={
          <span className="flex items-center gap-2">
            {t("title")}
            {status ? (
              <Badge variant={enabled ? "secondary" : "outline"}>{enabled ? t("on") : t("off")}</Badge>
            ) : null}
          </span>
        }
        description={
          enabled
            ? t("enabledDescription", { count: status?.recoveryCodesRemaining ?? 0 })
            : t("description")
        }
        action={
          status === null ? null : enabled ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setMode("regenerate")}>
                <KeyRound data-icon="inline-start" />
                {t("regenerate")}
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={() => setMode("disable")}>
                <ShieldOff data-icon="inline-start" />
                {t("disable")}
              </Button>
            </div>
          ) : (
            <Button type="button" size="sm" onClick={() => setMode("setup")}>
              <ShieldCheck data-icon="inline-start" />
              {t("enable")}
            </Button>
          )
        }
      />
      <SetupDialog
        open={mode === "setup"}
        token={token}
        onOpenChange={(open) => {
          if (!open) {
            setMode(null)
            void refresh()
          }
        }}
      />
      <CodeDialog
        mode={mode === "disable" || mode === "regenerate" ? mode : null}
        token={token}
        onClose={() => {
          setMode(null)
          void refresh()
        }}
      />
    </>
  )
}

function SetupDialog({
  open,
  token,
  onOpenChange,
}: {
  open: boolean
  token: string
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("pages.settings.twoFactor")
  const [setup, setSetup] = React.useState<TotpSetup | null>(null)
  const [qrImage, setQrImage] = React.useState<string | null>(null)
  const [code, setCode] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null)

  React.useEffect(() => {
    if (!open) {
      setSetup(null)
      setQrImage(null)
      setCode("")
      setError(null)
      setRecoveryCodes(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const next = await authApi.beginTotpSetup(token)
        const image = await QRCode.toDataURL(next.otpauthUri, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 220,
          color: { dark: "#111111", light: "#ffffff" },
        })
        if (cancelled) return
        setSetup(next)
        setQrImage(image)
      } catch (err) {
        if (!cancelled) setError(errorText(err, t))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, t, token])

  const close = () => {
    if (setup && !recoveryCodes) void authApi.cancelTotpSetup(token).catch(() => undefined)
    onOpenChange(false)
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving || !/^\d{6}$/.test(code.trim())) return
    setSaving(true)
    setError(null)
    try {
      const result = await authApi.enableTotp(token, code)
      setRecoveryCodes(result.recoveryCodes)
      toast.success(t("enabledToast"))
    } catch (err) {
      setError(errorText(err, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{recoveryCodes ? t("recoveryTitle") : t("setupTitle")}</DialogTitle>
          <DialogDescription>
            {recoveryCodes ? t("recoveryDescription") : t("setupDescription")}
          </DialogDescription>
        </DialogHeader>
        {recoveryCodes ? (
          <>
            <RecoveryCodeList codes={recoveryCodes} />
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t("done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-6">
            <div className="flex flex-col items-center gap-3">
              {qrImage ? (
                <img src={qrImage} alt={t("qrAlt")} className="size-[220px] rounded-md bg-white" />
              ) : (
                <div className="flex size-[220px] items-center justify-center">
                  {error ? null : <Spinner />}
                </div>
              )}
              {setup ? (
                <div className="flex w-full flex-col items-center gap-1 text-center">
                  <span className="text-xs text-muted-foreground">{t("manualKey")}</span>
                  <code className="code-mono break-all text-sm">{groupSecret(setup.secret)}</code>
                </div>
              ) : null}
            </div>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="settings-totp-code">{t("codeLabel")}</FieldLabel>
                <Input
                  id="settings-totp-code"
                  value={code}
                  onChange={(event) => setCode(event.currentTarget.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  className="code-mono tracking-widest"
                  disabled={!setup}
                />
                <FieldDescription>{t("codeDescription")}</FieldDescription>
              </Field>
            </FieldGroup>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={saving || !setup || !/^\d{6}$/.test(code.trim())}>
                {saving ? <Spinner /> : <ShieldCheck data-icon="inline-start" />}
                {t("confirm")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function CodeDialog({
  mode,
  token,
  onClose,
}: {
  mode: "disable" | "regenerate" | null
  token: string
  onClose: () => void
}) {
  const t = useTranslations("pages.settings.twoFactor")
  const [code, setCode] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null)

  React.useEffect(() => {
    if (mode === null) {
      setCode("")
      setError(null)
      setSaving(false)
      setRecoveryCodes(null)
    }
  }, [mode])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving || !code.trim()) return
    setSaving(true)
    setError(null)
    try {
      if (mode === "disable") {
        await authApi.disableTotp(token, code)
        toast.success(t("disabledToast"))
        onClose()
      } else {
        const result = await authApi.regenerateTotpRecoveryCodes(token, code)
        setRecoveryCodes(result.recoveryCodes)
      }
    } catch (err) {
      setError(errorText(err, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={mode !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {recoveryCodes ? t("recoveryTitle") : mode === "disable" ? t("disableTitle") : t("regenerateTitle")}
          </DialogTitle>
          <DialogDescription>
            {recoveryCodes
              ? t("recoveryDescription")
              : mode === "disable"
                ? t("disableDescription")
                : t("regenerateDescription")}
          </DialogDescription>
        </DialogHeader>
        {recoveryCodes ? (
          <>
            <RecoveryCodeList codes={recoveryCodes} />
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                {t("done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-6">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="settings-totp-verify">{t("codeOrRecoveryLabel")}</FieldLabel>
                <Input
                  id="settings-totp-verify"
                  value={code}
                  onChange={(event) => setCode(event.currentTarget.value)}
                  autoComplete="one-time-code"
                  maxLength={32}
                  className="code-mono tracking-widest"
                  autoFocus
                />
              </Field>
            </FieldGroup>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                variant={mode === "disable" ? "destructive" : "default"}
                disabled={saving || !code.trim()}
              >
                {saving ? <Spinner /> : null}
                {mode === "disable" ? t("disable") : t("regenerate")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RecoveryCodeList({ codes }: { codes: string[] }) {
  const t = useTranslations("pages.settings.twoFactor")
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"))
      toast.success(t("copied"))
    } catch {
      toast.error(t("copyFailed"))
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-4">
        {codes.map((item) => (
          <li key={item} className="code-mono text-sm">
            {item}
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void copy()}>
        <Copy data-icon="inline-start" />
        {t("copy")}
      </Button>
    </div>
  )
}

function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim()
}

function errorText(error: unknown, t: (key: string) => string): string {
  if (isApiError(error)) {
    if (error.code === "totp_invalid_code") return t("invalidCode")
    if (error.code === "totp_locked") return t("locked")
    if (error.code === "secret_unconfigured") return t("secretUnconfigured")
  }
  return error instanceof Error ? error.message : t("failed")
}
