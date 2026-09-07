"use client"

import * as React from "react"
import {
  Apple,
  CheckCircle2,
  Clock,
  ExternalLink,
  Info,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  XCircle,
} from "lucide-react"
import { useTranslations } from "next-intl"
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
import { Progress } from "@/components/ui/progress"
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

function formatExpiry(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function resolveMobileWebUrl(): string {
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
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next) }}>
    <DialogTrigger asChild>{children}</DialogTrigger>
    <DialogContent className="sm:max-w-lg" showCloseButton={!busy}
      onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}
      onPointerDownOutside={(event) => { if (busy) event.preventDefault() }}>
      <DialogHeader className="sr-only"><DialogTitle>连接手机</DialogTitle><DialogDescription>下载手机客户端并扫码登录。</DialogDescription></DialogHeader>
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold">{stage === "install" ? t("installTitle") : t("scanTitle")}</h2>
          <span className="text-xs text-muted-foreground">{t("stepProgress", { current: currentStep, total: 2 })}</span>
        </div>
        <Progress value={currentStep * 50} />
      </div>
        {stage === "install" ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-6 py-4 text-center">
            <p className="text-base font-medium">{t("downloadPrompt")}</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button type="button" variant="outline" size="lg" className="min-w-36" asChild>
                <a href={PRODUCT_LINKS.androidDownloadUrl} target="_blank" rel="noreferrer">
                  <Smartphone data-icon="inline-start" />
                  {t("androidDownloadOption")}
                  <ExternalLink data-icon="inline-end" />
                </a>
              </Button>
              {PRODUCT_LINKS.iosDownloadUrl ? <Button type="button" variant="outline" size="lg" className="min-w-36" asChild>
                <a href={PRODUCT_LINKS.iosDownloadUrl} target="_blank" rel="noreferrer">
                  <Apple data-icon="inline-start" />{t("iosDownloadOption")}<ExternalLink data-icon="inline-end" />
                </a>
              </Button> : <Button type="button" variant="outline" size="lg" disabled><Apple data-icon="inline-start" />iOS 即将上线</Button>}
            </div>
          </div>
        ) : null}

        {stage === "generating" ? (
          <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("generating")}</p>
          </div>
        ) : null}

        {stage === "confirming" ? (
          <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("confirming")}</p>
          </div>
        ) : null}

        {stage === "scan" ? (
          <div className="flex min-h-72 flex-col gap-5">
            {error ? (
              <Alert variant="destructive">
                <XCircle />
                <AlertTitle>{t("errorTitle")}</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {!qrLogin ? (
              <ConnectionState
                icon={QrCode}
                title={t("generateFailedTitle")}
                description={t("generateFailedDescription")}
              />
            ) : status === "pending_web_confirm" ? (
              <div className="flex min-h-56 items-center">
                <Alert>
                  <ShieldCheck />
                  <AlertTitle>{t("pendingConfirmationTitle")}</AlertTitle>
                  <AlertDescription>{t("pendingConfirmationDescription")}</AlertDescription>
                </Alert>
              </div>
            ) : status === "approved" ? (
              <ConnectionState
                icon={Loader2}
                iconClassName="animate-spin"
                title={t("finishingTitle")}
                description={t("finishingDescription")}
              />
            ) : status === "consumed" ? (
              <ConnectionState
                icon={CheckCircle2}
                title={t("completeTitle")}
                description={t("completeDescription")}
                tone="success"
              />
            ) : status === "rejected" ? (
              <ConnectionState
                icon={XCircle}
                title={t("rejectedTitle")}
                description={t("rejectedDescription")}
                tone="destructive"
              />
            ) : status === "expired" ? (
              <ConnectionState
                icon={Clock}
                title={t("expiredTitle")}
                description={t("expiredDescription")}
              />
            ) : qrImage ? (
              <div className="flex flex-col items-center gap-4">
                <p className="flex max-w-md items-start gap-2 text-left text-sm text-muted-foreground">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  <span>{t("scanInstruction")}</span>
                </p>
                <div className="rounded-2xl border border-border bg-white p-3 shadow-sm">
                  <img
                    src={qrImage}
                    alt={t("qrAlt")}
                    className="size-[260px]"
                    width={260}
                    height={260}
                  />
                </div>
                <div className="flex flex-col items-center gap-1 text-center">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    <span>{t("waitingForScan")}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("expiresAt", { time: formatExpiry(qrLogin.expiresAt) })}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-3">
          {stage === "install" ? (
            <>
              <Button type="button" variant="ghost" onClick={handleExit}>
                {tCommon("cancel")}
              </Button>
              <Button type="button" onClick={() => void generateQr()}>
                {t("installedContinue")}
              </Button>
            </>
          ) : null}

          {stage === "generating" || stage === "confirming" ? (
            <Button type="button" variant="outline" disabled>
              {tCommon("back")}
            </Button>
          ) : null}

          {stage === "scan" && status === "pending_web_confirm" ? (
            <>
              <Button type="button" variant="outline" onClick={() => void confirmQrLogin(false)}>
                {t("rejectConnection")}
              </Button>
              <Button type="button" onClick={() => void confirmQrLogin(true)}>
                <ShieldCheck data-icon="inline-start" />
                {t("confirmConnection")}
              </Button>
            </>
          ) : null}

          {stage === "scan" && status === "consumed" ? (
            <Button type="button" onClick={onComplete}>
              <CheckCircle2 data-icon="inline-start" />
              {tCommon("done")}
            </Button>
          ) : null}

          {stage === "scan" && (status === "rejected" || status === "expired" || !qrLogin) ? (
            <>
              <Button type="button" variant="outline" onClick={returnToInstall}>
                {tCommon("back")}
              </Button>
              <Button type="button" onClick={() => void generateQr()}>
                <RefreshCw data-icon="inline-start" />
                {t("generateNew")}
              </Button>
            </>
          ) : null}

          {stage === "scan" && (status === "pending_scan" || !status || status === "approved") && qrLogin ? (
            <Button type="button" variant="outline" onClick={status === "approved" ? handleExit : returnToInstall}>
              {status === "approved" ? tCommon("close") : tCommon("back")}
            </Button>
          ) : null}
        </div>
    </div>
  )
}

function ConnectionState({
  icon: Icon,
  iconClassName,
  title,
  description,
  tone = "default",
}: {
  icon: React.ComponentType<{ className?: string }>
  iconClassName?: string
  title: string
  description: string
  tone?: "default" | "success" | "destructive"
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-4 py-6 text-center">
      <div
        className={cn(
          "flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground",
          tone === "success" && "bg-primary/10 text-primary",
          tone === "destructive" && "bg-destructive/10 text-destructive",
        )}
      >
        <Icon className={cn("size-8", iconClassName)} />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-base font-semibold">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
