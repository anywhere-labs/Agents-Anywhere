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
import { useTranslations } from "next-intl"
import { getDesktopServerConnection } from "@/features/desktop/server-connection"
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
  children: React.ReactElement
}

type Stage = "install" | "generating" | "scan" | "confirming"

const POLL_INTERVAL_MS = 1600
const TOTAL_STEPS = 2

function formatExpiry(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
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

function mobileLoginQrPayload(qr: MobileLoginQrCreateResponse) {
  return {
    type: "agents-anywhere.mobile-login",
    version: 1,
    webUrl: resolveMobileWebUrl(),
    userId: qr.userId,
    loginToken: qr.loginToken,
    expiresAt: qr.expiresAt,
  }
}

export function MobileConnectionDialog({ token, userId, children }: Props) {
  const t = useTranslations("dashboard.mobileConnections")
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next) }}>
    <DialogTrigger asChild>{children}</DialogTrigger>
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
  const generation = React.useRef(0)
  const operationPending = React.useRef(false)

  const clearQr = React.useCallback(() => {
    setError(null)
    setQrLogin(null)
    setQrStatus(null)
    setQrImage(null)
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
      const qr = await authApi.createMobileLoginQr(token)
      if (current !== generation.current) return
      const image = await QRCode.toDataURL(JSON.stringify(mobileLoginQrPayload(qr)), {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 260,
        color: { dark: "#111111", light: "#ffffff" },
      })
      if (current !== generation.current) return
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
  }, [clearQr, t, token])

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

  const status = qrStatus?.status
  const deviceName = qrStatus?.deviceName?.trim() || null
  const shouldPoll = Boolean(
    qrLogin
      && stage === "scan"
      && (!status || status === "pending_scan" || status === "pending_web_confirm" || status === "approved"),
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
    body = <DevicePrompt device={deviceName} />
    actions = <>
      <Button type="button" variant="outline" onClick={() => void confirmQrLogin(false)}>{t("rejectConnection")}</Button>
      <Button type="button" onClick={() => void confirmQrLogin(true)}>
        <ShieldCheck data-icon="inline-start" />
        {t("confirmConnection")}
      </Button>
    </>
  } else if (status === "approved") {
    title = t("finishingTitle")
    description = t("finishingDescription")
    body = <BusyBody />
    actions = <Button type="button" variant="outline" onClick={handleExit}>{tCommon("close")}</Button>
  } else if (status === "consumed") {
    title = t("completeTitle")
    description = t("completeDescription")
    body = deviceName ? <DeviceRow name={deviceName} /> : <StateGlyph icon={CheckCircle2} tone="success" />
    actions = <Button type="button" onClick={onComplete}>
      <CheckCircle2 data-icon="inline-start" />
      {tCommon("done")}
    </Button>
  } else if (status === "rejected" || status === "expired" || !qrLogin) {
    const failed = !qrLogin
    title = failed ? t("generateFailedTitle") : status === "rejected" ? t("rejectedTitle") : t("expiredTitle")
    description = failed ? t("generateFailedDescription") : status === "rejected" ? t("rejectedDescription") : t("expiredDescription")
    body = <StateGlyph
      icon={failed ? QrCode : status === "rejected" ? XCircle : Clock}
      tone={status === "rejected" ? "destructive" : "default"}
    />
    actions = <>
      <Button type="button" variant="outline" onClick={returnToInstall}>{tCommon("back")}</Button>
      <Button type="button" onClick={() => void generateQr()}>
        <RefreshCw data-icon="inline-start" />
        {t("generateNew")}
      </Button>
    </>
  } else {
    body = <QrPanel image={qrImage} expiresAt={qrLogin?.expiresAt ?? ""} />
    actions = <Button type="button" variant="outline" onClick={returnToInstall}>{tCommon("back")}</Button>
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <StepIndicator current={currentStep} total={TOTAL_STEPS} label={t("stepProgress", { current: currentStep, total: TOTAL_STEPS })} />
        <div className="flex flex-col gap-2">
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
  if (!image) return null
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="rounded-3xl bg-white p-3 shadow-lg shadow-foreground/5 ring-1 ring-foreground/5">
        <img
          src={image}
          alt={t("qrAlt")}
          className="size-[236px]"
          width={236}
          height={236}
        />
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>{t("waitingForScan")}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t("expiresAt", { time: formatExpiry(expiresAt) })}</p>
      </div>
    </div>
  )
}

function DevicePrompt({ device }: { device: string | null }) {
  const t = useTranslations("dashboard.mobileConnections")
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Smartphone className="size-6" />
      </div>
      {device ? (
        <div className="flex flex-col gap-1">
          <p className="text-balance text-base font-medium">{t("pendingConfirmationDevice", { device })}</p>
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
