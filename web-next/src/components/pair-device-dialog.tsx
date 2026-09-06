"use client"

import * as React from "react"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Hash,
  KeyRound,
  Laptop,
  Loader2,
  Terminal,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-context"
import { useAgentSetupPairing, type AgentSetupConnector } from "@/components/agent-setup-provider"
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { dashboardApi } from "@/features/dashboard/api"
import { preparePairingCredential, type PairingCredential } from "@/features/dashboard/pairing-credential"
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

const DESKTOP_DOWNLOAD_URL = "https://github.com/anywhere-labs/Agents-Anywhere/releases/latest"

type CliMethod = "command" | "pair-code"
type Step =
  | "connection-method"
  | "desktop-install"
  | "cli-confirm"
  | "name"
  | "cli-method"
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
        {copied ? <Check /> : <Copy />}
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
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: LucideIcon
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
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-foreground">
        <Icon data-icon="inline-start" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="block text-base font-medium">{title}</span>
        <span className="block break-words text-sm font-normal leading-relaxed text-muted-foreground">{description}</span>
      </span>
      <ArrowRight data-icon="inline-end" />
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
  const { requestAgentSetup, waitForConnector, readyConnectorIds } = useAgentSetupPairing()
  const t = useTranslations("dashboard.pairDevice")
  const tCommon = useTranslations("common")
  const [step, setStep] = React.useState<Step>(setupCredential ? "cli-method" : "connection-method")
  const [name, setName] = React.useState(() => setupCredential?.connector.name ?? randomName())
  const [credential, setCredential] = React.useState<PairingCredential | null>(setupCredential)
  const [pairCode, setPairCode] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const [claiming, setClaiming] = React.useState(false)
  const [waitingOnline, setWaitingOnline] = React.useState(false)
  const [createdThisFlow, setCreatedThisFlow] = React.useState(false)
  const [exitGuardOpen, setExitGuardOpen] = React.useState(false)
  const pairingVersionRef = React.useRef(0)
  const suppressCloseGuardRef = React.useRef(false)
  const serverUrl = React.useMemo(resolvePairingServerUrl, [])
  const connectorId = credential?.connector.id ?? null
  const connectorToken = credential?.connectorToken ?? null

  const shouldConfirmExit = connectorId !== null && createdThisFlow

  const stopWaiting = React.useCallback(() => {
    pairingVersionRef.current += 1
    setWaitingOnline(false)
  }, [])

  const reset = React.useCallback(() => {
    stopWaiting()
    setStep(setupCredential ? "cli-method" : "connection-method")
    setName(setupCredential?.connector.name ?? randomName())
    setCredential(setupCredential)
    setPairCode("")
    setCreating(false)
    setClaiming(false)
    setCreatedThisFlow(false)
  }, [setupCredential, stopWaiting])

  React.useEffect(() => {
    if (!open || !setupCredential) return
    setStep("cli-method")
    setName(setupCredential.connector.name)
    setCredential(setupCredential)
  }, [open, setupCredential])

  React.useEffect(() => () => { pairingVersionRef.current += 1 }, [])

  const closePairing = React.useCallback(() => {
    setExitGuardOpen(false)
    reset()
    onOpenChange(false)
  }, [onOpenChange, reset])

  const completePairing = React.useCallback((pairedConnector?: AgentSetupConnector) => {
    if (pairedConnector) requestAgentSetup(pairedConnector)
    onConnectorCreated?.()
    closePairing()
  }, [closePairing, onConnectorCreated, requestAgentSetup])

  const startConnectorWaiting = (connector: AgentSetupConnector) => {
    stopWaiting()
    setWaitingOnline(true)
    waitForConnector(connector)
  }

  React.useEffect(() => {
    if (!open || !waitingOnline || !connectorId || !readyConnectorIds.includes(connectorId)) return
    closePairing()
  }, [closePairing, connectorId, open, readyConnectorIds, waitingOnline])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (creating || claiming)) return
    if (!nextOpen && suppressCloseGuardRef.current) return
    if (!nextOpen && shouldConfirmExit) {
      setExitGuardOpen(true)
      return
    }
    if (!nextOpen) reset()
    onOpenChange(nextOpen)
  }

  const goBack = () => {
    if (creating || claiming) return
    stopWaiting()
    if (step === "command" || step === "pair-code") {
      setStep("cli-method")
    } else if (step === "cli-method") {
      setStep("name")
    } else {
      setStep("connection-method")
    }
  }

  const routeToCliMethod = (method: CliMethod) => {
    if (!connectorId || !connectorToken) {
      setStep("name")
      return
    }
    setStep(method)
    if (method === "command") startConnectorWaiting({ id: connectorId, name })
  }

  const handleCreate = async () => {
    if (!name.trim() || !session?.accessToken || creating) return
    const version = pairingVersionRef.current
    setCreating(true)
    try {
      const result = await preparePairingCredential(session.accessToken, name, credential)
      if (version !== pairingVersionRef.current) return
      setCredential(result)
      setName(result.connector.name)
      if (!credential) setCreatedThisFlow(true)
      setStep("cli-method")
    } catch (error) {
      if (version !== pairingVersionRef.current) return
      toast.error(error instanceof Error ? error.message : t("errors.createFailed"))
    } finally {
      if (version === pairingVersionRef.current) setCreating(false)
    }
  }

  const handleClaim = async () => {
    if (pairCode.length < 6 || !session?.accessToken || !connectorId || !connectorToken) return
    const version = pairingVersionRef.current
    setClaiming(true)
    try {
      await dashboardApi.claimPairing(session.accessToken, {
        code: pairCode,
        name: name.trim(),
        serverUrl,
        connectorId,
        connectorToken,
      })
      if (version !== pairingVersionRef.current) return
      completePairing({ id: connectorId, name: name.trim() })
    } catch (error) {
      if (version !== pairingVersionRef.current) return
      toast.error(error instanceof Error ? error.message : t("errors.claimFailed"))
    } finally {
      if (version === pairingVersionRef.current) setClaiming(false)
    }
  }

  const handleForceClose = () => {
    closePairing()
  }

  const continuePairing = () => {
    suppressCloseGuardRef.current = true
    setExitGuardOpen(false)
    window.setTimeout(() => {
      suppressCloseGuardRef.current = false
    }, 0)
  }

  const pairServer = pairServerAddress(serverUrl)
  const pairCommand = `uvx anywhere-cli pair ${shellQuote(pairServer)}`
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
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <div
            key={step}
            className="flex min-w-0 flex-col gap-6 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-4 motion-safe:duration-200"
          >
            {step === "connection-method" ? (
              <>
                <DialogHeader className="gap-3 pr-6">
                  <DialogTitle className="text-2xl leading-tight sm:text-3xl">{title ?? t("connectionTitle")}</DialogTitle>
                  <DialogDescription>{t("connectionDescription")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                  <ChoiceCard
                    icon={Laptop}
                    title={t("desktopTitle")}
                    description={t("desktopDescription")}
                    onClick={() => setStep("desktop-install")}
                  />
                  <ChoiceCard
                    icon={Terminal}
                    title={t("cliTitle")}
                    description={t("cliDescription")}
                    onClick={() => setStep("cli-confirm")}
                  />
                </div>
              </>
            ) : null}

            {step === "desktop-install" ? (
              <>
                <DialogHeader className="gap-3 pr-6">
                  <DialogTitle className="text-2xl leading-tight">{t("desktopInstallTitle")}</DialogTitle>
                  <DialogDescription>{t("desktopInstallDescription")}</DialogDescription>
                </DialogHeader>
                <Button size="lg" className="w-full sm:w-fit" asChild>
                  <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
                    {t("githubReleases")}
                    <ExternalLink data-icon="inline-end" />
                  </a>
                </Button>
                <ol className="flex list-decimal flex-col gap-5 pl-5 text-sm marker:text-muted-foreground">
                  <li className="pl-1">
                    <div className="flex flex-col gap-1">
                      <p className="font-medium">{t("desktopDownloadTitle")}</p>
                      <p className="leading-relaxed text-muted-foreground">{t("desktopInstallStepDownload")}</p>
                    </div>
                  </li>
                  <li className="pl-1">
                    <div className="flex flex-col gap-1">
                      <p className="font-medium">{t("desktopLoginTitle")}</p>
                      <p className="leading-relaxed text-muted-foreground">{t("desktopInstallStepLogin")}</p>
                    </div>
                  </li>
                  <li className="pl-1">
                    <div className="flex flex-col gap-1">
                      <p className="font-medium">{t("desktopOnlineTitle")}</p>
                      <p className="leading-relaxed text-muted-foreground">{t("desktopInstallStepOnline")}</p>
                    </div>
                  </li>
                </ol>
                <DialogFooter className="gap-2 sm:justify-between">
                  <Button type="button" variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
                    <ArrowLeft data-icon="inline-start" />
                    {tCommon("back")}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => completePairing()}>{tCommon("done")}</Button>
                </DialogFooter>
              </>
            ) : null}

            {step === "cli-confirm" ? (
              <>
                <DialogHeader className="gap-3 pr-6">
                  <DialogTitle className="text-2xl leading-tight">{t("commandWarningTitle")}</DialogTitle>
                  <DialogDescription>{t("commandWarningDescription")}</DialogDescription>
                </DialogHeader>
                <p className="text-sm leading-relaxed text-muted-foreground">{t("commandWarningFallback")}</p>
                <DialogFooter className="gap-2 sm:justify-between">
                  <Button type="button" variant="ghost" size="sm" onClick={goBack}>
                    <ArrowLeft data-icon="inline-start" />
                    {tCommon("back")}
                  </Button>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button type="button" variant="outline" onClick={() => setStep("desktop-install")}>
                      {t("commandWarningDesktop")}
                    </Button>
                    <Button type="button" onClick={() => setStep("name")}>
                      {t("commandWarningConfirm")}
                    </Button>
                  </div>
                </DialogFooter>
              </>
            ) : null}

            {step === "cli-method" ? (
              <>
                <DialogHeader className="gap-3 pr-6">
                  <DialogTitle className="text-2xl leading-tight">{t("methodTitle")}</DialogTitle>
                  <DialogDescription>{t("methodDescription", { name })}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                  <ChoiceCard
                    icon={Hash}
                    title={t("pairCodeTitle")}
                    description={t("pairCodeDescription")}
                    onClick={() => routeToCliMethod("pair-code")}
                  />
                  <ChoiceCard
                    icon={KeyRound}
                    title={t("tokenTitle")}
                    description={t("tokenDescription")}
                    onClick={() => routeToCliMethod("command")}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
                    <ArrowLeft data-icon="inline-start" />
                    {tCommon("back")}
                  </Button>
                </DialogFooter>
              </>
            ) : null}

            {step === "name" ? (
              <>
                <DialogHeader className="gap-3 pr-6">
                  <DialogTitle className="text-2xl leading-tight">{t("nameTitle")}</DialogTitle>
                  <DialogDescription>{t("nameDescription")}</DialogDescription>
                </DialogHeader>
                <FieldGroup className="py-2">
                  <Field data-disabled={creating}>
                    <FieldLabel htmlFor="device-name">{t("nameLabel")}</FieldLabel>
                    <Input
                      id="device-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={t("namePlaceholder")}
                      disabled={creating}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) void handleCreate()
                      }}
                      autoFocus
                    />
                  </Field>
                </FieldGroup>
                <DialogFooter className="gap-2 sm:justify-between">
                  <Button type="button" variant="ghost" size="sm" onClick={goBack} disabled={creating}>
                    <ArrowLeft data-icon="inline-start" />
                    {tCommon("back")}
                  </Button>
                  <Button type="button" onClick={() => void handleCreate()} disabled={!name.trim() || creating}>
                    {creating ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                    {tCommon("continue")}
                  </Button>
                </DialogFooter>
              </>
            ) : null}

            {step === "command" ? (
              <>
                <DialogHeader className="gap-3 pr-6">
                  <DialogTitle className="text-2xl leading-tight">{t("commandStepTitle")}</DialogTitle>
                  <DialogDescription>{t("commandStepDescription", { name })}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 py-2">
                  <CodeBlock code={tokenCommand} copyLabel={t("copyCommand")} />
                  <p className="pt-2 text-sm text-muted-foreground">{t("linuxSessionWarning")}</p>
                  <CodeBlock code={`screen -S anywhere\n${tokenCommand}`} copyLabel={t("copyCommand")} />
                  <p className="pt-2 text-sm text-muted-foreground">{t("linuxDetachHint")}</p>
                  <CodeBlock code="screen -r anywhere" copyLabel={t("copyCommand")} />
                  {waitingOnline ? <PollingIndicator label={t("waitingOnline")} /> : null}
                </div>
                <DialogFooter>
                  <Button type="button" variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
                    <ArrowLeft data-icon="inline-start" />
                    {tCommon("back")}
                  </Button>
                </DialogFooter>
              </>
            ) : null}

            {step === "pair-code" ? (
              <>
                <DialogHeader className="gap-3 pr-6">
                  <DialogTitle className="text-2xl leading-tight">{t("codeStepTitle")}</DialogTitle>
                  <DialogDescription>{t("codeStepDescription", { name })}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4 py-2">
                  <div className="rounded-xl border bg-muted/25 p-4 text-sm">
                    <div className="font-medium">{t("pairCommand")}</div>
                    <div className="mt-3">
                      <CodeBlock code={pairCommand} copyLabel={t("copyCommand")} />
                    </div>
                    <p className="mt-3 text-muted-foreground">{t("pairCommandHint")}</p>
                  </div>
                  <FieldGroup>
                    <Field data-disabled={claiming}>
                      <FieldLabel htmlFor="device-pair-code">{t("codeLabel")}</FieldLabel>
                      <InputOTP
                        id="device-pair-code"
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
                    </Field>
                  </FieldGroup>
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
                    <ArrowLeft data-icon="inline-start" />
                    {tCommon("back")}
                  </Button>
                  <Button type="button" onClick={() => void handleClaim()} disabled={pairCode.length < 6 || claiming}>
                    {claiming ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
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
            <AlertDialogDescription>{t(waitingOnline ? "exitWaitingDescription" : "exitDescription", { name })}</AlertDialogDescription>
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
