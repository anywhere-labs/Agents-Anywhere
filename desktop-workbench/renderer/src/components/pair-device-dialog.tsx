"use client"

import * as React from "react"
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Laptop,
  Loader2,
  Monitor,
  Terminal,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-context"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { dashboardApi } from "@/features/dashboard/api"
import type { ConnectorCreateResponse, ConnectorRevokeResponse } from "@/features/dashboard/types"
import { cn } from "@/lib/utils"

const ADJECTIVES = [
  "amber", "azure", "brisk", "calm", "clear", "clever", "copper", "crisp", "deft", "eager",
  "fair", "fleet", "fresh", "gentle", "golden", "happy", "honest", "jade", "keen", "lively",
  "lucky", "lunar", "mellow", "nimble", "noble", "opal", "quiet", "rapid", "silver", "smart",
  "solar", "steady", "swift", "tidy", "vivid", "warm", "witty", "zesty", "bright", "cosmic",
]
const NOUNS = [
  "acorn", "anchor", "badger", "bamboo", "beacon", "birch", "brook", "cedar", "clover", "comet",
  "condor", "cove", "falcon", "finch", "fjord", "forest", "garden", "grove", "harbor", "heron",
  "island", "juniper", "lagoon", "lantern", "maple", "meadow", "meteor", "nebula", "otter", "phoenix",
  "quartz", "raven", "ridge", "river", "rocket", "sequoia", "sparrow", "summit", "willow", "zephyr",
]

const GITHUB_RELEASES_URL = "https://github.com/anywhere-labs/Agents-Anywhere/releases"

type Platform = "macos" | "windows" | "linux"
type LinuxMethod = "terminal" | "pair-code"
type Step =
  | "platform"
  | "desktop-install"
  | "linux-method"
  | "name"
  | "command"
  | "pair-code"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnectorCreated?: () => void
  /** Transitional compatibility for callers still passing a rotated CLI credential. */
  setupCredential?: ConnectorCreateResponse | ConnectorRevokeResponse | null
  title?: string
}

function randomName(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adjective}-${noun}`
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
    // Keep the configured value visible when it cannot be parsed as a URL.
  }
  return serverUrl
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function CodeBlock({ code, copyLabel }: { code: string; copyLabel: string }) {
  const [copied, setCopied] = React.useState(false)
  const copy = () => {
    navigator.clipboard.writeText(code).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="grid rounded-lg border border-border bg-muted/40" style={{ gridTemplateColumns: "1fr auto" }}>
      <ScrollArea className="min-w-0">
        <div className="px-4 py-3">
          <code className="block whitespace-pre code-mono text-xs text-foreground">{code}</code>
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={copy}
        aria-label={copyLabel}
        className="m-2 self-center text-muted-foreground"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}

function PollingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      <span>{label}</span>
    </div>
  )
}

function ChoiceCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className="h-auto w-full min-w-0 justify-start gap-3 whitespace-normal px-4 py-4 text-left"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="mt-0.5 block break-words text-sm font-normal text-muted-foreground">{description}</span>
      </span>
    </Button>
  )
}

export function PairDeviceDialog({
  open,
  onOpenChange,
  onConnectorCreated,
  setupCredential = null,
  title,
}: Props) {
  const { session } = useAuth()
  const t = useTranslations("dashboard.pairDevice")
  const tCommon = useTranslations("common")
  const [step, setStep] = React.useState<Step>(setupCredential ? "linux-method" : "platform")
  const [platform, setPlatform] = React.useState<Platform | null>(setupCredential ? "linux" : null)
  const [linuxMethod, setLinuxMethod] = React.useState<LinuxMethod | null>(null)
  const [name, setName] = React.useState(() => setupCredential?.connector.name ?? randomName())
  const [connectorId, setConnectorId] = React.useState<string | null>(() => setupCredential?.connector.id ?? null)
  const [connectorToken, setConnectorToken] = React.useState<string | null>(() => setupCredential?.connectorToken ?? null)
  const [pairCode, setPairCode] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const [claiming, setClaiming] = React.useState(false)
  const [polling, setPolling] = React.useState(false)
  const [createdThisFlow, setCreatedThisFlow] = React.useState(false)
  const [exitGuardOpen, setExitGuardOpen] = React.useState(false)
  const pollingRef = React.useRef<number | null>(null)
  const suppressCloseGuardRef = React.useRef(false)
  const serverUrl = React.useMemo(resolvePairingServerUrl, [])

  const shouldConfirmExit = connectorId !== null && createdThisFlow

  const stopPolling = React.useCallback(() => {
    if (pollingRef.current) window.clearTimeout(pollingRef.current)
    pollingRef.current = null
    setPolling(false)
  }, [])

  const reset = React.useCallback(() => {
    stopPolling()
    setStep(setupCredential ? "linux-method" : "platform")
    setPlatform(setupCredential ? "linux" : null)
    setLinuxMethod(null)
    setName(setupCredential?.connector.name ?? randomName())
    setConnectorId(setupCredential?.connector.id ?? null)
    setConnectorToken(setupCredential?.connectorToken ?? null)
    setPairCode("")
    setCreating(false)
    setClaiming(false)
    setCreatedThisFlow(false)
  }, [setupCredential, stopPolling])

  React.useEffect(() => {
    if (!open || !setupCredential) return
    setStep("linux-method")
    setPlatform("linux")
    setName(setupCredential.connector.name)
    setConnectorId(setupCredential.connector.id)
    setConnectorToken(setupCredential.connectorToken)
  }, [open, setupCredential])

  React.useEffect(() => () => stopPolling(), [stopPolling])

  const completePairing = React.useCallback(() => {
    reset()
    onConnectorCreated?.()
    onOpenChange(false)
  }, [onConnectorCreated, onOpenChange, reset])

  const startConnectorPolling = React.useCallback((id: string) => {
    if (!session?.accessToken) return
    setPolling(true)
    const tick = async () => {
      try {
        const { connector } = await dashboardApi.getConnector(session.accessToken, id)
        if (connector.status === "online") {
          completePairing()
          return
        }
        pollingRef.current = window.setTimeout(tick, 2000)
      } catch {
        pollingRef.current = window.setTimeout(tick, 3000)
      }
    }
    pollingRef.current = window.setTimeout(tick, 1500)
  }, [completePairing, session?.accessToken])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && suppressCloseGuardRef.current) return
    if (!nextOpen && shouldConfirmExit) {
      setExitGuardOpen(true)
      return
    }
    if (!nextOpen) reset()
    onOpenChange(nextOpen)
  }

  const goBack = () => {
    stopPolling()
    if (step === "desktop-install" || step === "linux-method") {
      setStep("platform")
    } else {
      setStep("linux-method")
    }
  }

  const selectPlatform = (nextPlatform: Platform) => {
    setPlatform(nextPlatform)
    setStep(nextPlatform === "linux" ? "linux-method" : "desktop-install")
  }

  const routeToLinuxMethod = (method: LinuxMethod) => {
    setLinuxMethod(method)
    if (!connectorId || !connectorToken) {
      setStep("name")
      return
    }
    setStep(method === "terminal" ? "command" : "pair-code")
    if (method === "terminal") startConnectorPolling(connectorId)
  }

  const handleCreate = async () => {
    if (!name.trim() || !session?.accessToken || !linuxMethod) return
    setCreating(true)
    try {
      const result = await dashboardApi.createConnector(session.accessToken, name.trim())
      setConnectorId(result.connector.id)
      setConnectorToken(result.connectorToken)
      setName(result.connector.name)
      setCreatedThisFlow(true)
      setStep(linuxMethod === "terminal" ? "command" : "pair-code")
      if (linuxMethod === "terminal") startConnectorPolling(result.connector.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.createFailed"))
    } finally {
      setCreating(false)
    }
  }

  const handleClaim = async () => {
    if (pairCode.length < 6 || !session?.accessToken || !connectorId || !connectorToken) return
    setClaiming(true)
    try {
      await dashboardApi.claimPairing(session.accessToken, {
        code: pairCode,
        name: name.trim(),
        serverUrl,
        connectorId,
        connectorToken,
      })
      completePairing()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.claimFailed"))
    } finally {
      setClaiming(false)
    }
  }

  const handleForceClose = () => {
    setExitGuardOpen(false)
    stopPolling()
    reset()
    onOpenChange(false)
  }

  const continuePairing = () => {
    suppressCloseGuardRef.current = true
    setExitGuardOpen(false)
    window.setTimeout(() => {
      suppressCloseGuardRef.current = false
    }, 0)
  }

  const pairServer = pairServerAddress(serverUrl)
  const tokenCommand = connectorId && connectorToken
    ? [
      "uvx anywhere-cli start",
      `--server-url ${shellQuote(serverUrl)}`,
      `--connector-id ${shellQuote(connectorId)}`,
      `--connector-token ${shellQuote(connectorToken)}`,
    ].join(" ")
    : ""

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="overflow-hidden sm:max-w-2xl">
          <div
            key={step}
            className="grid gap-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-4 motion-safe:duration-200"
          >
            {step === "platform" ? (
              <>
                <DialogHeader>
                  <DialogTitle>{title ?? t("platformTitle")}</DialogTitle>
                  <DialogDescription>{t("platformDescription")}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 py-2 sm:grid-cols-3">
                  <ChoiceCard
                    icon={<Laptop className="size-5" />}
                    title={t("platformMacos")}
                    description={t("platformMacosDescription")}
                    onClick={() => selectPlatform("macos")}
                  />
                  <ChoiceCard
                    icon={<Monitor className="size-5" />}
                    title={t("platformWindows")}
                    description={t("platformWindowsDescription")}
                    onClick={() => selectPlatform("windows")}
                  />
                  <ChoiceCard
                    icon={<Terminal className="size-5" />}
                    title={t("platformLinux")}
                    description={t("platformLinuxDescription")}
                    onClick={() => selectPlatform("linux")}
                  />
                </div>
              </>
            ) : null}

            {step === "desktop-install" && platform !== "linux" ? (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {t("desktopInstallTitle", {
                      platform: t(platform === "macos" ? "platformMacos" : "platformWindows"),
                    })}
                  </DialogTitle>
                </DialogHeader>
                <ol className="grid gap-3 py-2 text-sm">
                  <li className="rounded-xl border bg-muted/25 p-4">{t("desktopInstallStepDownload")}</li>
                  <li className="rounded-xl border bg-muted/25 p-4">{t("desktopInstallStepLogin")}</li>
                  <li className="rounded-xl border bg-muted/25 p-4">{t("desktopInstallStepOnline")}</li>
                </ol>
                <DialogFooter className="gap-2 sm:justify-between">
                  <Button type="button" variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
                    <ArrowLeft className="size-3.5" />
                    {tCommon("back")}
                  </Button>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" asChild>
                      <a href={GITHUB_RELEASES_URL} target="_blank" rel="noreferrer">
                        {t("githubReleases")}
                        <ExternalLink className="size-3.5" />
                      </a>
                    </Button>
                    <Button type="button" onClick={completePairing}>{tCommon("done")}</Button>
                  </div>
                </DialogFooter>
              </>
            ) : null}

            {step === "linux-method" ? (
              <>
                <DialogHeader>
                  <DialogTitle>{t("linuxMethodTitle")}</DialogTitle>
                  <DialogDescription>{t("linuxMethodDescription")}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 py-2">
                  <ChoiceCard
                    icon={<Terminal className="size-5" />}
                    title={t("linuxTerminalTitle")}
                    description={t("linuxTerminalDescription")}
                    onClick={() => routeToLinuxMethod("terminal")}
                  />
                  <ChoiceCard
                    icon={<Monitor className="size-5" />}
                    title={t("linuxPairCodeTitle")}
                    description={t("linuxPairCodeDescription")}
                    onClick={() => routeToLinuxMethod("pair-code")}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
                    <ArrowLeft className="size-3.5" />
                    {tCommon("back")}
                  </Button>
                </DialogFooter>
              </>
            ) : null}

            {step === "name" ? (
              <>
                <DialogHeader>
                  <DialogTitle>{t("nameTitle")}</DialogTitle>
                  <DialogDescription>{t("nameDescription")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-2 py-2">
                  <Label htmlFor="device-name">{t("nameLabel")}</Label>
                  <Input
                    id="device-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t("namePlaceholder")}
                    className="code-mono"
                    onKeyDown={(event) => event.key === "Enter" && void handleCreate()}
                    autoFocus
                  />
                </div>
                <DialogFooter className="gap-2 sm:justify-between">
                  <Button type="button" variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
                    <ArrowLeft className="size-3.5" />
                    {tCommon("back")}
                  </Button>
                  <Button type="button" onClick={() => void handleCreate()} disabled={!name.trim() || creating}>
                    {creating ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t("createDevice")}
                  </Button>
                </DialogFooter>
              </>
            ) : null}

            {step === "command" ? (
              <>
                <DialogHeader>
                  <DialogTitle>{t("commandStepTitle")}</DialogTitle>
                  <DialogDescription>{t("commandStepDescription", { name })}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 py-2">
                  <CodeBlock code={tokenCommand} copyLabel={t("copyCommand")} />
                  <p className="pt-2 text-sm text-muted-foreground">{t("linuxSessionWarning")}</p>
                  <CodeBlock code={`screen -S anywhere\n${tokenCommand}`} copyLabel={t("copyCommand")} />
                  <p className="pt-2 text-sm text-muted-foreground">{t("linuxDetachHint")}</p>
                  <CodeBlock code="screen -r anywhere" copyLabel={t("copyCommand")} />
                  {polling ? <PollingIndicator label={t("waitingOnline")} /> : null}
                </div>
                <DialogFooter>
                  <Button type="button" variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
                    <ArrowLeft className="size-3.5" />
                    {tCommon("back")}
                  </Button>
                </DialogFooter>
              </>
            ) : null}

            {step === "pair-code" ? (
              <>
                <DialogHeader>
                  <DialogTitle>{t("codeStepTitle")}</DialogTitle>
                  <DialogDescription>{t("codeStepDescription", { name })}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4 py-2">
                  <div className="rounded-xl border bg-muted/25 p-4 text-sm">
                    <div className="font-medium">{t("serverAddress")}</div>
                    <div className="mt-2 break-all font-mono text-xs text-muted-foreground">{pairServer}</div>
                    <p className="mt-2 text-muted-foreground">{t("serverAddressHint")}</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>{t("codeLabel")}</Label>
                    <InputOTP
                      maxLength={6}
                      value={pairCode}
                      onChange={(value) => setPairCode(value.replace(/\D/g, "").slice(0, 6))}
                      disabled={claiming}
                      inputMode="numeric"
                      aria-label={t("codeLabel")}
                      containerClassName={cn("w-full justify-between", claiming && "opacity-40")}
                    >
                      <InputOTPGroup className="w-full">
                        {Array.from({ length: 6 }).map((_, index) => (
                          <InputOTPSlot key={index} index={index} className="h-12 flex-1 text-xl" />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                  {claiming ? <PollingIndicator label={t("confirming")} /> : null}
                </div>
                <DialogFooter className="gap-2 sm:justify-between">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={goBack}
                    className="gap-1.5"
                    disabled={claiming}
                  >
                    <ArrowLeft className="size-3.5" />
                    {tCommon("back")}
                  </Button>
                  <Button type="button" onClick={() => void handleClaim()} disabled={pairCode.length < 6 || claiming}>
                    {claiming ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t("claim")}
                  </Button>
                </DialogFooter>
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={exitGuardOpen} onOpenChange={setExitGuardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("exitTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("exitDescription", { name })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={continuePairing}>{t("continuePairing")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleForceClose}>{t("closeAnyway")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
