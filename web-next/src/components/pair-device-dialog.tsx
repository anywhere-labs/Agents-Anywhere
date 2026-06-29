"use client"

import * as React from "react"
import { Copy, Check, Loader2, CheckCircle2, ArrowLeft, MonitorUp } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import type { ConnectorCreateResponse, ConnectorRevokeResponse } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

// ── Readable name generator ────────────────────────────────
const ADJECTIVES = ["amber", "brisk", "calm", "deft", "eager", "fair", "gilt", "hale", "jade", "keen", "lush", "mild", "neat", "opal", "pine", "rose", "sage", "teal", "umber", "vivid"]
const NOUNS = ["badger", "birch", "brook", "canopy", "cedar", "clover", "cobalt", "condor", "creek", "daisy", "falcon", "fern", "finch", "glade", "harbor", "heron", "linden", "magpie", "maple", "marsh"]

function randomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adj}-${noun}`
}

function resolvePairingServerUrl(): string {
  if (typeof window === "undefined") return ""
  const { hostname, origin } = window.location
  const isLocalDev = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  if (isLocalDev) {
    const api = process.env.NEXT_PUBLIC_AGENTS_ANYWHERE_API
    if (api) return api.replace(/\/$/, "")
  }
  return origin.replace(/\/$/, "")
}

function pairServerAddress(serverUrl: string): string {
  try {
    const url = new URL(serverUrl)
    if (url.protocol === "https:") return url.host
  } catch {
    return serverUrl
  }
  return serverUrl
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function desktopConnectorUrl(serverUrl: string, connectorId: string, connectorToken: string): string {
  const params = new URLSearchParams({
    serverUrl,
    connectorId,
    connectorToken,
  })
  return `agents-anywhere://start?${params.toString()}`
}

// ── Types ──────────────────────────────────────────────────
type Step = "name" | "method" | "token" | "paircode" | "success"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnectorCreated?: () => void
  setupCredential?: ConnectorCreateResponse | ConnectorRevokeResponse | null
  title?: string
}

// ── Inline code block ──────────────────────────────────────
function CodeBlock({ code }: { code: string }) {
  const t = useTranslations("dashboard.pairDevice")
  const [copied, setCopied] = React.useState(false)
  const copy = () => {
    navigator.clipboard.writeText(code).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="grid rounded-lg border border-border bg-muted/40" style={{ gridTemplateColumns: "1fr auto" }}>
      <ScrollArea className="min-w-0">
        <div className="px-4 py-3">
        <code className="block whitespace-nowrap code-mono text-xs text-foreground">{code}</code>
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      {/* copy button: outside scroll area, always visible, same vertical padding */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={copy}
        aria-label={t("copyCommand")}
        className="m-2 self-center text-muted-foreground"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}

// ── Polling indicator ──────────────────────────────────────
function PollingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      <span>{label}</span>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────
export function PairDeviceDialog({ open, onOpenChange, onConnectorCreated, setupCredential = null, title }: Props) {
  const { session } = useAuth()
  const t = useTranslations("dashboard.pairDevice")
  const tCommon = useTranslations("common")
  const [step, setStep] = React.useState<Step>(() => (setupCredential ? "method" : "name"))
  const [name, setName] = React.useState(() => setupCredential?.connector.name ?? randomName())
  const [connectorId, setConnectorId] = React.useState<string | null>(() => setupCredential?.connector.id ?? null)
  const [token, setToken] = React.useState<string | null>(() => setupCredential?.connectorToken ?? null)
  const [pairCode, setPairCode] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const [claiming, setClaiming] = React.useState(false)
  const [polling, setPolling] = React.useState(false)
  const [exitGuardOpen, setExitGuardOpen] = React.useState(false)
  const pollingRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressCloseGuardRef = React.useRef(false)
  const serverUrl = React.useMemo(resolvePairingServerUrl, [])

  // Stable device-created guard: once connector exists, closing needs confirmation
  const deviceCreated = connectorId !== null && step !== "success"

  React.useEffect(() => {
    if (!open) return
    if (setupCredential) {
      setStep("method")
      setName(setupCredential.connector.name)
      setConnectorId(setupCredential.connector.id)
      setToken(setupCredential.connectorToken)
    }
  }, [open, setupCredential])

  const stopPolling = () => {
    if (pollingRef.current) clearTimeout(pollingRef.current)
    pollingRef.current = null
    setPolling(false)
  }

  const startConnectorPolling = React.useCallback((cid: string) => {
    if (!session?.accessToken) return
    setPolling(true)
    const tick = async () => {
      try {
        const { connector } = await dashboardApi.getConnector(session.accessToken, cid)
        if (connector.status === "online") {
          stopPolling()
          setStep("success")
        } else {
          pollingRef.current = setTimeout(tick, 2000)
        }
      } catch {
        pollingRef.current = setTimeout(tick, 3000)
      }
    }
    pollingRef.current = setTimeout(tick, 1500)
  }, [session?.accessToken])

  React.useEffect(() => {
    return () => stopPolling()
  }, [])

  const reset = () => {
    stopPolling()
    setStep("name")
    setName(setupCredential?.connector.name ?? randomName())
    setConnectorId(setupCredential?.connector.id ?? null)
    setToken(setupCredential?.connectorToken ?? null)
    setPairCode("")
    setCreating(false)
    setClaiming(false)
    setPolling(false)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && suppressCloseGuardRef.current) return
    if (!next && deviceCreated) {
      setExitGuardOpen(true)
      return
    }
    if (!next) reset()
    onOpenChange(next)
  }

  const continuePairing = () => {
    suppressCloseGuardRef.current = true
    setExitGuardOpen(false)
    window.setTimeout(() => {
      suppressCloseGuardRef.current = false
    }, 0)
  }

  const handleCreate = async () => {
    if (!name.trim() || !session?.accessToken) return
    setCreating(true)
    try {
      const result = await dashboardApi.createConnector(session.accessToken, name.trim())
      setConnectorId(result.connector.id)
      setToken(result.connectorToken)
      setName(result.connector.name)
      setStep("method")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("errors.createFailed"))
    } finally {
      setCreating(false)
    }
  }

  const handleSelectToken = () => {
    if (!connectorId) return
    setStep("token")
    startConnectorPolling(connectorId)
  }

  const handleSelectPairCode = () => {
    setStep("paircode")
  }

  const handleClaim = async () => {
    const code = pairCode
    if (code.length < 6 || !session?.accessToken || !connectorId || !token) return
    setClaiming(true)
    try {
      const result = await dashboardApi.claimPairing(session.accessToken, {
        code,
        name: name.trim(),
        serverUrl,
        connectorId,
        connectorToken: token,
      })
      if (result.connector?.id) setConnectorId(result.connector.id)
      onConnectorCreated?.()
      setStep("success")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("errors.claimFailed"))
    } finally {
      setClaiming(false)
    }
  }

  const handleForceClose = async () => {
    setExitGuardOpen(false)
    stopPolling()
    // Don't auto-delete; user must do it manually (as instructed)
    reset()
    onOpenChange(false)
  }

  const handleSuccessClose = () => {
    reset()
    onOpenChange(false)
    onConnectorCreated?.()
  }

  const tokenCommand = connectorId && token
    ? [
      "uvx anywhere-cli start",
      `--server-url ${shellQuote(serverUrl)}`,
      `--connector-id ${shellQuote(connectorId)}`,
      `--connector-token ${shellQuote(token)}`,
    ].join(" ")
    : ""

  const pairCodeCommand = `uvx anywhere-cli pair ${shellQuote(pairServerAddress(serverUrl))}`
  const desktopLaunchUrl = connectorId && token ? desktopConnectorUrl(serverUrl, connectorId, token) : ""

  const openDesktopConnector = () => {
    if (!desktopLaunchUrl) return
    window.location.href = desktopLaunchUrl
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-2xl">

          {/* ── Step: Name ── */}
          {step === "name" && (
            <>
              <DialogHeader>
                <DialogTitle>{t("nameTitle")}</DialogTitle>
                <DialogDescription>
                  {t("nameDescription")}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2 py-2">
                <Label htmlFor="device-name">{t("nameLabel")}</Label>
                <Input
                  id="device-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("namePlaceholder")}
                  className="code-mono"
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button onClick={handleCreate} disabled={!name.trim() || creating} className="w-full">
                  {creating && <Loader2 className="mr-2 size-4 animate-spin" />}
                  {t("createDevice")}
                </Button>
              </DialogFooter>
            </>
          )}

          {/* ── Step: Method ── */}
          {step === "method" && (
            <>
              <DialogHeader>
                <DialogTitle>{title ?? t("methodTitle")}</DialogTitle>
                <DialogDescription>
                  {t("methodDescription", { name })}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3 py-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSelectToken}
                  className="h-auto w-full min-w-0 flex-col items-start gap-0.5 whitespace-normal px-4 py-3 text-left"
                >
                  <span className="min-w-0 font-medium">{t("tokenTitle")}</span>
                  <span className="min-w-0 break-words text-sm text-muted-foreground">{t("tokenDescription")}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSelectPairCode}
                  className="h-auto w-full min-w-0 flex-col items-start gap-0.5 whitespace-normal px-4 py-3 text-left"
                >
                  <span className="min-w-0 font-medium">{t("pairCodeTitle")}</span>
                  <span className="min-w-0 break-words text-sm text-muted-foreground">{t("pairCodeDescription")}</span>
                </Button>
              </div>
            </>
          )}

          {/* ── Step: Token ── */}
          {step === "token" && (
            <>
              <DialogHeader>
                <DialogTitle>{t("tokenStepTitle")}</DialogTitle>
                <DialogDescription>
                  {t("tokenStepDescription", { name })}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3 py-2">
                <Button
                  type="button"
                  onClick={openDesktopConnector}
                  disabled={!desktopLaunchUrl}
                  className="w-full justify-start"
                >
                  <MonitorUp className="size-4" />
                  {t("openDesktopConnector")}
                </Button>
                <CodeBlock code={tokenCommand} />
                <PollingIndicator label={t("waitingOnline")} />
              </div>
              <DialogFooter>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { stopPolling(); setStep("method") }}
                  className="gap-1.5"
                >
                  <ArrowLeft className="size-3.5" />
                  {tCommon("back")}
                </Button>
              </DialogFooter>
            </>
          )}

          {/* ── Step: Pair code ── */}
          {step === "paircode" && (
            <>
              <DialogHeader>
                <DialogTitle>{t("codeStepTitle")}</DialogTitle>
                <DialogDescription>
                  {t("codeStepDescription", { name })}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-2">
                <CodeBlock code={pairCodeCommand} />
                <div className="flex flex-col gap-2">
                  <Label>{t("codeLabel")}</Label>
                  <InputOTP
                    maxLength={6}
                    value={pairCode}
                    onChange={(value) => setPairCode(value.replace(/\D/g, "").slice(0, 6))}
                    disabled={polling}
                    inputMode="numeric"
                    aria-label={t("codeLabel")}
                    containerClassName={cn("w-full justify-between", polling && "opacity-40")}
                  >
                    <InputOTPGroup className="w-full">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <InputOTPSlot key={i} index={i} className="h-12 flex-1 text-xl" />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                {polling && <PollingIndicator label={t("confirming")} />}
              </div>
              <DialogFooter className="gap-2 sm:gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { stopPolling(); setStep("method") }}
                  className="gap-1.5"
                  disabled={polling}
                >
                  <ArrowLeft className="size-3.5" />
                  {tCommon("back")}
                </Button>
                <Button
                  onClick={handleClaim}
                  disabled={pairCode.length < 6 || claiming || polling}
                  className="flex-1"
                >
                  {claiming && <Loader2 className="mr-2 size-4 animate-spin" />}
                  {t("claim")}
                </Button>
              </DialogFooter>
            </>
          )}

          {/* ── Step: Success ── */}
          {step === "success" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <CheckCircle2 className="size-5 text-emerald-500" />
                  {t("successTitle")}
                </DialogTitle>
                <DialogDescription>
                  {t("successDescription", { name })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button onClick={handleSuccessClose} className="w-full">{tCommon("done")}</Button>
              </DialogFooter>
            </>
          )}

        </DialogContent>
      </Dialog>

      {/* Exit guard */}
      <AlertDialog open={exitGuardOpen} onOpenChange={setExitGuardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("exitTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("exitDescription", { name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={continuePairing}>{t("continuePairing")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleForceClose}>
              {t("closeAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
