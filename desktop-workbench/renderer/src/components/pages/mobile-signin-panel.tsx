"use client"

import * as React from "react"
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  XCircle,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { getDesktopServerConnection } from "@/features/desktop/server-connection"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import QRCode from "qrcode"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { authApi } from "@/features/auth/api"
import type {
  MobileLoginQrCreateResponse,
  MobileLoginStatusResponse,
} from "@/features/auth/types"
import { cn } from "@/lib/utils"
import { PRODUCT_LINKS } from "@/lib/product-links"

type Props = {
  token: string
  userId: string
  /** Rendered as the dialog trigger. Omit it to drive the dialog with `open`. */
  children?: React.ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

type Stage = "install" | "generating" | "scan" | "confirming"

const POLL_INTERVAL_MS = 1600
const TOTAL_STEPS = 2

function formatExpiry(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
}

function resolveMobileWebUrl(): string {
  const publicUrl = getDesktopServerConnection()?.serverUrl
  if (publicUrl) return publicUrl
  if (typeof window === "undefined") return ""

  const { hostname, origin } = window.location
  const isLocalDev = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  if (isLocalDev) {
    const api = process.env.NEXT_PUBLIC_AGENTS_ANYWHERE_API
    if (api) return api.replace(/\/$/, "")
  }

  return origin.replace(/\/$/, "")
}

async function sealInvitation(uri: string, keyText: string, loginToken: string) {
  const raw = Uint8Array.from(atob(keyText.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(loginToken) },
    key, new TextEncoder().encode(uri))
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(sealed))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function mobileLoginQrPayload(qr: MobileLoginQrCreateResponse, encryptedPairing?: string) {
  return {
    type: "agents-anywhere.mobile-login",
    version: encryptedPairing ? 2 : 1,
    ...(encryptedPairing ? { encryptedPairing } : {}),
    webUrl: resolveMobileWebUrl(),
    userId: qr.userId,
    loginToken: qr.loginToken,
    expiresAt: qr.expiresAt,
  }
}

export function MobileConnectionDialog({ token, userId, children, open: controlledOpen, onOpenChange }: Props) {
  const t = useTranslations("dashboard.mobileConnections")
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next)
    else setUncontrolledOpen(next)
  }
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next) }}>
    {children ? <DialogTrigger asChild>{children}</DialogTrigger> : null}
    <DialogContent className="sm:max-w-md" showCloseButton={!busy}
      onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}
      onPointerDownOutside={(event) => { if (busy) event.preventDefault() }}>
      <DialogHeader className="sr-only">
        <DialogTitle>{t("onboardingTitle")}</DialogTitle>
        <DialogDescription>{t("onboardingDescription")}</DialogDescription>
      </DialogHeader>
      {open ? <MobileConnectionContent token={token} userId={userId}
        onComplete={() => setOpen(false)} onCancel={() => setOpen(false)} onBusyChange={setBusy} /> : null}
    </DialogContent>
  </Dialog>
}

export function MobileConnectionContent({ token, userId, onComplete, onCancel, onBusyChange, onStepChange }: {
  token: string
  userId: string
  onComplete: () => void
  onCancel: () => void
  onBusyChange?: (busy: boolean) => void
  onStepChange?: (step: 'install' | 'scan') => void
}) {
  const t = useTranslations("dashboard.mobileConnections")
  const tCommon = useTranslations("common")
  const [stage, setStage] = React.useState<Stage>("install")
  const [error, setError] = React.useState<string | null>(null)
  const [qrLogin, setQrLogin] = React.useState<MobileLoginQrCreateResponse | null>(null)
  const [qrStatus, setQrStatus] = React.useState<MobileLoginStatusResponse | null>(null)
  const [qrImage, setQrImage] = React.useState<string | null>(null)
  const [invitation, setInvitation] = React.useState<{ id: string; expiresAt: number } | null>(null)
  const pairingId = invitation?.id
  const [paired, setPaired] = React.useState(false)
  const [invalid, setInvalid] = React.useState(false)
  const [now, setNow] = React.useState(Date.now)
  const connector = getDesktopWorkbenchBridge()?.connector
  const generation = React.useRef(0)
  const operationPending = React.useRef(false)

  const clearQr = React.useCallback(() => {
    setError(null)
    setQrLogin(null)
    setQrStatus(null)
    setQrImage(null)
    setInvitation(null)
    setPaired(false)
    setInvalid(false)
  }, [])

  const reset = React.useCallback(() => {
    clearQr()
    setStage("install")
  }, [clearQr])

  React.useEffect(() => {
    generation.current++
    reset()
    return () => { generation.current++ }
  }, [reset, token, userId])

  const generateQr = React.useCallback(async () => {
    if (operationPending.current) return
    if (!token) {
      setError(t("accountUnavailable"))
      setStage("scan")
      return
    }

    operationPending.current = true
    const current = generation.current
    setStage("generating")
    clearQr()

    try {
      const serverRequiresEncryption = (await authApi.config()).e2ee?.mode === "required"
      const origin = new URL(resolveMobileWebUrl()).origin
      // A local device can still require encryption after the server relaxes its policy.
      const local = serverRequiresEncryption ? undefined : await connector?.getState().catch(() => undefined)
      const localMatches = local?.running && local.serverUrl && new URL(local.serverUrl).origin === origin
      const invite = serverRequiresEncryption || localMatches ? await connector?.startClientPairing() : undefined
      if ((serverRequiresEncryption && !invite?.ok) || (invite && !invite.ok && invite.code !== "e2ee_off")) {
        throw new Error(t("connectorRequired"))
      }
      const encrypted = invite?.ok === true
      if (invite?.ok) {
        const data = JSON.parse(atob(invite.uri.slice("aa-pair://".length).replace(/-/g, "+").replace(/_/g, "/")))
        if (new URL(data.serverUrl).origin !== origin) throw new Error(t("connectorRequired"))
      }
      const qr = await authApi.createMobileLoginQr(token, encrypted)
      if (encrypted && !qr.pairingKey) throw new Error(t("connectorRequired"))
      const sealed = invite?.ok && qr.pairingKey ? await sealInvitation(invite.uri, qr.pairingKey, qr.loginToken) : undefined
      if (current !== generation.current) return
      const image = await QRCode.toDataURL(JSON.stringify(mobileLoginQrPayload(qr, sealed)), {
        errorCorrectionLevel: "M",
        margin: 4,
        scale: 5,
        color: { dark: "#111111", light: "#ffffff" },
      })
      if (current !== generation.current) return
      setNow(Date.now())
      setInvitation(invite?.ok ? { id: invite.pairingId, expiresAt: Date.parse(invite.expiresAt) } : null)
      setQrLogin(qr)
      setQrImage(image)
      setStage("scan")
    } catch (err) {
      if (current !== generation.current) return
      setError(err instanceof Error ? err.message : t("generateFailed"))
      setStage("scan")
    } finally {
      operationPending.current = false
    }
  }, [clearQr, connector, t, token])

  const confirmQrLogin = React.useCallback(async (approved: boolean) => {
    if (!qrLogin || operationPending.current) return
    operationPending.current = true
    const current = generation.current

    setStage("confirming")
    setError(null)

    try {
      const status = await authApi.confirmMobileLogin(token, qrLogin.loginToken, approved)
      if (current !== generation.current) return
      setQrStatus(status)
      setStage("scan")
    } catch (err) {
      if (current !== generation.current) return
      setError(err instanceof Error ? err.message : t("confirmFailed"))
      setStage("scan")
    } finally {
      operationPending.current = false
    }
  }, [qrLogin, t, token])

  const consumed = qrStatus?.status === "consumed"
  const elapsed = qrLogin && now >= Date.parse(qrLogin.expiresAt)
  const grantExpired = consumed && invitation && !paired && now >= invitation.expiresAt
  const status = invalid || grantExpired || (elapsed && !consumed) ? "expired" : qrStatus?.status
  const finished = consumed && (!pairingId || paired || invalid || Boolean(grantExpired))
  React.useEffect(() => {
    if (!qrLogin || finished) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [qrLogin, finished])

  React.useEffect(() => {
    if (!pairingId || !connector) return
    let closed = false
    let timer: ReturnType<typeof setTimeout>
    async function check() {
      try {
        const result = await connector!.clientPairingStatus(pairingId!)
        if (closed) return
        if (result.status === "paired") { setPaired(true); return }
        if (result.status === "invalid") { setInvalid(true); return }
      } catch { /* Recheck after a temporary Connector outage. */ }
      if (!closed) timer = setTimeout(check, POLL_INTERVAL_MS)
    }
    void check()
    return () => { closed = true; clearTimeout(timer) }
  }, [pairingId, connector])
  const deviceName = qrStatus?.deviceName?.trim() || null
  const shouldPoll = Boolean(
    qrLogin
      && stage === "scan"
      && !invalid && (!qrStatus || ["pending_scan", "pending_web_confirm", "approved"].includes(qrStatus.status)),
  )

  React.useEffect(() => {
    if (!shouldPoll || !qrLogin) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const nextStatus = await authApi.mobileLoginStatus(token, qrLogin.loginToken)
        if (!cancelled) setQrStatus(nextStatus)
      } catch {
        // A transient polling failure should not interrupt the connection flow.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    }

    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [qrLogin, shouldPoll, token])

  const busy = stage === "generating" || stage === "confirming"
  const currentStep = stage === "install" ? 1 : 2

  React.useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  React.useEffect(() => { onStepChange?.(stage === 'install' ? 'install' : 'scan') }, [stage, onStepChange])

  const handleExit = () => { reset(); onCancel() }

  const returnToInstall = () => {
    clearQr()
    setStage("install")
  }

  // One heading, one description and one action row per state, mirroring the
  // onboarding slides instead of stacking boxed alerts inside the dialog.
  let title = t("scanTitle")
  let description: string | null = t("scanInstruction")
  let body: React.ReactNode = null
  let actions: React.ReactNode = null

  if (stage === "install") {
    title = t("installTitle")
    description = t("downloadPrompt")
    body = <DownloadLink />
    actions = <>
      <Button type="button" variant="ghost" onClick={handleExit}>{tCommon("cancel")}</Button>
      <Button type="button" onClick={() => void generateQr()}>{t("installedContinue")}</Button>
    </>
  } else if (stage === "generating") {
    description = t("generating")
    body = <BusyBody />
    actions = <Button type="button" variant="outline" disabled>{tCommon("back")}</Button>
  } else if (stage === "confirming") {
    title = t("pendingConfirmationTitle")
    description = t("confirming")
    body = <BusyBody />
  } else if (status === "pending_web_confirm") {
    title = t("pendingConfirmationTitle")
    description = deviceName ? null : t("pendingConfirmationDescription")
    // Icon first, then the device sentence: this is the security check.
    body = <DevicePrompt device={deviceName} encrypted={Boolean(pairingId)} />
    actions = <>
      <Button type="button" variant="outline" onClick={() => void confirmQrLogin(false)}>{t("rejectConnection")}</Button>
      <Button type="button" onClick={() => void confirmQrLogin(true)}>
        <ShieldCheck data-icon="inline-start" />
        {t("confirmConnection")}
      </Button>
    </>
  } else if (status === "approved" || (status === "consumed" && pairingId && !paired)) {
    title = t("finishingTitle")
    description = t(consumed && pairingId ? "waitingEncrypted" : "finishingDescription")
    body = <BusyBody />
    actions = <Button type="button" variant="outline" onClick={handleExit}>{tCommon("close")}</Button>
  } else if (status === "consumed") {
    title = t("completeTitle")
    description = t(pairingId ? "encryptedComplete" : "completeDescription")
    body = deviceName ? <DeviceRow name={deviceName} /> : <StateGlyph icon={CheckCircle2} tone="success" />
    actions = <Button type="button" onClick={onComplete}>
      <CheckCircle2 data-icon="inline-start" />
      {tCommon("done")}
    </Button>
  } else if (status === "rejected" || status === "expired" || !qrLogin) {
    const failed = !qrLogin
    title = failed ? t("generateFailedTitle") : status === "rejected" ? t("rejectedTitle") : t("expiredTitle")
    description = failed ? t("generateFailedDescription") : status === "rejected" ? t("rejectedDescription") : t("expiredDescription")
    body = status === "expired" && qrImage ? (
      <button type="button" onClick={() => void generateQr()}
        className="relative mx-auto overflow-hidden rounded-2xl focus-visible:ring-2 focus-visible:ring-ring">
        <img src={qrImage} alt="" className="size-64 blur-sm brightness-[.25]" />
        <span className="absolute inset-0 flex items-center justify-center gap-2 font-medium text-white">
          <RefreshCw className="size-5" />{t("generateNew")}
        </span>
      </button>
    ) : <StateGlyph
      icon={failed ? QrCode : status === "rejected" ? XCircle : Clock}
      tone={status === "rejected" ? "destructive" : "default"}
    />
    actions = <>
      <Button type="button" variant="outline" onClick={returnToInstall}>{tCommon("back")}</Button>
      {!(status === "expired" && qrImage) && <Button type="button" onClick={() => void generateQr()}>
        <RefreshCw data-icon="inline-start" />
        {t("generateNew")}
      </Button>}
    </>
  } else {
    const remaining = Math.max(0, Math.ceil((Date.parse(qrLogin.expiresAt) - now) / 1000))
    body = <><QrPanel image={qrImage} expiresAt={qrLogin.expiresAt} />
      <p role="timer" className="text-center text-sm tabular-nums">{t("remaining", { time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` })}</p></>
    actions = <Button type="button" variant="outline" onClick={returnToInstall}>{tCommon("back")}</Button>
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <StepIndicator current={currentStep} total={TOTAL_STEPS} label={t("stepProgress", { current: currentStep, total: TOTAL_STEPS })} />
        <div className="flex flex-col gap-2">
          {pairingId && <span className="inline-flex items-center gap-1 text-sm"><ShieldCheck size={16} />{t("encrypted")}</span>}
          <h2 className="text-balance text-2xl font-medium leading-tight tracking-[-0.025em]">{title}</h2>
          {description ? <p className="text-pretty text-sm leading-6 text-muted-foreground">{description}</p> : null}
        </div>
      </header>

      {error ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>{t("errorTitle")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {body ? <div className="flex flex-col">{body}</div> : null}

      {actions ? <div className="flex flex-wrap items-center justify-end gap-3">{actions}</div> : null}
    </div>
  )
}

function StepIndicator({ current, total, label }: { current: number; total: number; label: string }) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label={label}>
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(
            "h-1.5 rounded-full transition-all",
            index + 1 === current ? "w-6 bg-primary" : "w-1.5 bg-border",
          )}
        />
      ))}
    </div>
  )
}

function DownloadLink() {
  const t = useTranslations("dashboard.mobileConnections")
  return (
    <div className="flex flex-col items-start gap-3">
      <Button type="button" variant="outline" size="lg" asChild>
        <a href={PRODUCT_LINKS.downloadPageUrl} target="_blank" rel="noreferrer">
          <Smartphone data-icon="inline-start" />
          {t("openDownloadPage")}
          <ExternalLink data-icon="inline-end" />
        </a>
      </Button>
      <p className="text-xs leading-5 text-muted-foreground">
        {t("downloadUrlHint", { url: PRODUCT_LINKS.downloadPageUrl })}
      </p>
    </div>
  )
}

function QrPanel({ image, expiresAt }: { image: string | null; expiresAt: string }) {
  const t = useTranslations("dashboard.mobileConnections")
  const locale = useLocale()
  if (!image) return null
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="rounded-3xl bg-white p-3 shadow-lg shadow-foreground/5 ring-1 ring-foreground/5">
        <img
          src={image}
          alt={t("qrAlt")}
          className="size-64 max-w-full [image-rendering:pixelated]"
          width={256}
          height={256}
        />
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>{t("waitingForScan")}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t("expiresAt", { time: formatExpiry(expiresAt, locale) })}</p>
      </div>
    </div>
  )
}

function DevicePrompt({ device, encrypted }: { device: string | null; encrypted: boolean }) {
  const t = useTranslations("dashboard.mobileConnections")
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Smartphone className="size-6" />
      </div>
      {device ? (
        <div className="flex flex-col gap-1">
          <p className="text-balance text-base font-medium">{t(encrypted ? "pendingEncryptedDevice" : "pendingConfirmationDevice", { device })}</p>
          <p className="text-sm text-muted-foreground">{t("pendingConfirmationHint")}</p>
        </div>
      ) : null}
    </div>
  )
}

function DeviceRow({ name }: { name: string }) {
  const t = useTranslations("dashboard.mobileConnections")
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-muted/30 px-3 py-2.5">
      <Smartphone className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="sr-only">{t("confirmDevice")}</span>
        <span className="block truncate text-sm font-medium">{name}</span>
      </span>
    </div>
  )
}

function BusyBody() {
  return (
    <div className="flex items-center justify-center py-4">
      <Loader2 className="size-7 animate-spin text-muted-foreground" />
    </div>
  )
}

function StateGlyph({
  icon: Icon,
  tone = "default",
}: {
  icon: React.ComponentType<{ className?: string }>
  tone?: "default" | "success" | "destructive"
}) {
  return (
    <div className="flex justify-center py-2">
      <div
        className={cn(
          "flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground",
          tone === "success" && "bg-primary/10 text-primary",
          tone === "destructive" && "bg-destructive/10 text-destructive",
        )}
      >
        <Icon className="size-6" />
      </div>
    </div>
  )
}
