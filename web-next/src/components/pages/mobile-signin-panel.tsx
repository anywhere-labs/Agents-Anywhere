"use client"

import * as React from "react"
import QRCode from "qrcode"
import { QrCode, Loader2, CheckCircle2, XCircle, ShieldAlert, RefreshCw, Smartphone, Clock } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { authApi } from "@/features/auth/api"
import type { MobileLoginQrCreateResponse, MobileLoginStatusResponse } from "@/features/auth/types"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

type Props = {
  token: string
  userId: string
}

type Step = "idle" | "confirm_risk" | "generating" | "showing_qr" | "confirming"

const POLL_INTERVAL_MS = 1600

function formatExpiry(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function resolveMobileWebUrl(): string {
  if (typeof window === "undefined") return ""
  // Phone apps call this URL directly. Always embed the browser origin so LAN
  // access (e.g. http://192.168.x.x:18080) works; never rewrite to 127.0.0.1 API.
  return window.location.origin.replace(/\/$/, "")
}

function isLoopbackWebUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
  } catch {
    return true
  }
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

export function MobileSignInPanel({ token, userId }: Props) {
  const t = useTranslations("pages.settings")
  const [open, setOpen] = React.useState(false)
  const [step, setStep] = React.useState<Step>("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [qrLogin, setQrLogin] = React.useState<MobileLoginQrCreateResponse | null>(null)
  const [qrStatus, setQrStatus] = React.useState<MobileLoginStatusResponse | null>(null)
  const [qrImage, setQrImage] = React.useState<string | null>(null)

  const busy = step === "generating" || step === "confirming"

  const reset = React.useCallback(() => {
    setStep("idle")
    setError(null)
    setQrLogin(null)
    setQrStatus(null)
    setQrImage(null)
  }, [])

  const handleOpen = React.useCallback((value: boolean) => {
    if (busy) return
    if (!value) reset()
    else setStep("confirm_risk")
    setOpen(value)
  }, [busy, reset])

  const webUrl = typeof window !== "undefined" ? resolveMobileWebUrl() : ""
  const loopbackBlocked = Boolean(webUrl && isLoopbackWebUrl(webUrl))

  const generateQr = React.useCallback(async () => {
    const origin = resolveMobileWebUrl()
    if (!origin || isLoopbackWebUrl(origin)) {
      setError(t("mobileLoopbackBlocked"))
      setStep("confirm_risk")
      return
    }
    setStep("generating")
    setError(null)
    try {
      const qr = await authApi.createMobileLoginQr(token)
      const image = await QRCode.toDataURL(JSON.stringify(mobileLoginQrPayload(qr)), {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 260,
        color: { dark: "#111111", light: "#ffffff" },
      })
      setQrLogin(qr)
      setQrStatus(null)
      setQrImage(image)
      setStep("showing_qr")
    } catch (err) {
      const message = err instanceof Error ? err.message : t("mobileQrFailed")
      setError(message)
      setStep("confirm_risk")
    }
  }, [t, token])

  const confirmQrLogin = React.useCallback(async (approved: boolean) => {
    if (!qrLogin) return
    setStep("confirming")
    setError(null)
    try {
      const status = await authApi.confirmMobileLogin(token, qrLogin.loginToken, approved)
      setQrStatus(status)
      setStep("showing_qr")
    } catch (err) {
      const message = err instanceof Error ? err.message : t("mobileConfirmFailed")
      setError(message)
      setStep("showing_qr")
    }
  }, [qrLogin, t, token])

  // Poll status while QR is showing
  React.useEffect(() => {
    if (!open || !qrLogin || step !== "showing_qr") return
    let cancelled = false

    const poll = async () => {
      try {
        const status = await authApi.mobileLoginStatus(token, qrLogin.loginToken)
        if (!cancelled) setQrStatus(status)
      } catch {
        // Ignore transient poll failures.
      }
    }
    void poll()
    const timer = window.setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [open, qrLogin, step, token])

  // Reset on userId change
  React.useEffect(() => {
    setOpen(false)
    reset()
  }, [reset, userId])

  const status = qrStatus?.status
  const isTerminal = status === "approved" || status === "rejected" || status === "expired"

  return (
    <>
      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between px-6 py-5">
          <div>
            <h2 className="text-base font-semibold">{t("mobileSignIn")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t("mobileDescription")}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => handleOpen(true)}>
            <QrCode className="size-3.5" />
            {t("generateQr")}
          </Button>
        </div>
      </section>

      <Dialog open={open} onOpenChange={handleOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("mobileSignIn")}</DialogTitle>
            <DialogDescription>
              {step === "confirm_risk" ? t("mobileRiskDescription", { userId }) : t("mobileScanDescription")}
            </DialogDescription>
          </DialogHeader>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {step === "confirm_risk" && loopbackBlocked && (
            <Alert variant="destructive">
              <ShieldAlert className="size-4" />
              <AlertDescription>{t("mobileLoopbackBlocked")}</AlertDescription>
            </Alert>
          )}

          {step === "confirm_risk" && !loopbackBlocked && (
            <Alert>
              <ShieldAlert className="size-4" />
              <AlertDescription>{t("mobileRiskNote", { userId })}</AlertDescription>
            </Alert>
          )}

          {step === "generating" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("mobileGenerating")}</p>
            </div>
          )}

          {step === "showing_qr" && qrLogin && (
            <div className="flex flex-col items-center gap-4">
              {(!status || status === "pending_scan") && qrImage ? (
                <>
                  <div className="rounded-xl border border-border bg-white p-3">
                    <img
                      src={qrImage}
                      alt={t("mobileQrAlt")}
                      className="size-[260px]"
                      width={260}
                      height={260}
                    />
                  </div>
                  <Separator />
                  <div className="w-full space-y-2 text-center">
                    <div className="flex items-center justify-center gap-2 text-sm">
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      <span className="text-muted-foreground">{t("mobileStatus.waiting")}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("mobileExpires", { time: formatExpiry(qrLogin.expiresAt) })}
                    </p>
                    <p className="code-mono text-xs text-muted-foreground">{qrLogin.userId}</p>
                  </div>
                </>
              ) : (
                <StatusCard
                  status={status ?? ""}
                  deviceName={qrStatus?.deviceName ?? null}
                  expiry={qrLogin.expiresAt}
                />
              )}
            </div>
          )}

          {step === "confirming" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("mobileConfirming")}</p>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            {step === "confirm_risk" && (
              <>
                <Button variant="outline" onClick={() => handleOpen(false)}>
                  {t("cancel")}
                </Button>
                <Button onClick={() => void generateQr()} disabled={loopbackBlocked}>
                  {t("generateQr")}
                </Button>
              </>
            )}

            {step === "showing_qr" && (
              <>
                {status === "pending_web_confirm" ? (
                  <>
                    <Button variant="outline" onClick={() => void confirmQrLogin(false)} disabled={busy}>
                      {t("reject")}
                    </Button>
                    <Button variant="destructive" onClick={() => void confirmQrLogin(true)} disabled={busy}>
                      {t("mobileConfirm")}
                    </Button>
                  </>
                ) : isTerminal ? (
                  <>
                    <Button variant="outline" onClick={() => handleOpen(false)} disabled={busy}>
                      {t("close")}
                    </Button>
                    <Button onClick={() => void generateQr()} disabled={busy}>
                      <RefreshCw className="size-3.5" />
                      {t("mobileGenerateNew")}
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" onClick={() => handleOpen(false)} disabled={busy} className="w-full">
                    {t("cancel")}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─── Status card shown after scan / on terminal states ──────────────

type StatusCardProps = {
  status: string
  deviceName: string | null
  expiry: string
}

function StatusCard({ status, deviceName, expiry }: StatusCardProps) {
  const t = useTranslations("pages.settings")

  const config: Record<string, {
    icon: React.ComponentType<{ className?: string }>
    iconBg: string
    iconColor: string
    titleKey: string
    showExpiry?: boolean
  }> = {
    pending_web_confirm: {
      icon: Smartphone,
      iconBg: "bg-amber-500/10",
      iconColor: "text-amber-500",
      titleKey: "mobileStatus.pending_web_confirm",
    },
    approved: {
      icon: CheckCircle2,
      iconBg: "bg-emerald-500/10",
      iconColor: "text-emerald-500",
      titleKey: "mobileStatus.approved",
    },
    rejected: {
      icon: XCircle,
      iconBg: "bg-destructive/10",
      iconColor: "text-destructive",
      titleKey: "mobileStatus.rejected",
    },
    expired: {
      icon: Clock,
      iconBg: "bg-muted",
      iconColor: "text-muted-foreground",
      titleKey: "mobileStatus.expired",
      showExpiry: true,
    },
  }

  const info = config[status]
  if (!info) {
    // consumed / unknown — treat as completed
    return (
      <div className="flex flex-col items-center gap-4 py-4">
        <div className="flex size-16 items-center justify-center rounded-full bg-emerald-500/10">
          <CheckCircle2 className="size-8 text-emerald-500" />
        </div>
        <div className="text-center">
          <p className="text-base font-semibold">{t("mobileStatus.approved")}</p>
        </div>
      </div>
    )
  }

  const Icon = info.icon

  return (
    <div className="flex flex-col items-center gap-4 py-4">
      <div className={cn("flex size-16 items-center justify-center rounded-full", info.iconBg)}>
        <Icon className={cn("size-8", info.iconColor)} />
      </div>
      <div className="text-center space-y-1">
        <p className="text-base font-semibold">{t(info.titleKey)}</p>
        {status === "pending_web_confirm" && deviceName && (
          <p className="text-sm text-muted-foreground">{deviceName}</p>
        )}
        {info.showExpiry && (
          <p className="text-xs text-muted-foreground">
            {t("mobileExpires", { time: formatExpiry(expiry) })}
          </p>
        )}
      </div>
    </div>
  )
}