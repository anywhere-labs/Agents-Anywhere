"use client"

import * as React from "react"
import { Copy, Check, Loader2, CheckCircle2, ArrowLeft } from "lucide-react"
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
import { cn } from "@/lib/utils"
import {
  createConnector,
  deleteConnector,
  pollConnectorOnline,
  getPairCode,
  claimConnector,
} from "@/lib/api"

// ── Readable name generator ────────────────────────────────
const ADJECTIVES = ["amber", "brisk", "calm", "deft", "eager", "fair", "gilt", "hale", "jade", "keen", "lush", "mild", "neat", "opal", "pine", "rose", "sage", "teal", "umber", "vivid"]
const NOUNS = ["badger", "birch", "brook", "canopy", "cedar", "clover", "cobalt", "condor", "creek", "daisy", "falcon", "fern", "finch", "glade", "harbor", "heron", "linden", "magpie", "maple", "marsh"]

function randomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adj}-${noun}`
}

// ── Types ──────────────────────────────────────────────────
type Step = "name" | "method" | "token" | "paircode" | "success"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnectorCreated?: () => void
}

// ── Inline code block ──────────────────────────────────────
function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false)
  const copy = () => {
    navigator.clipboard.writeText(code).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="grid rounded-lg border border-border bg-muted/40" style={{ gridTemplateColumns: "1fr auto" }}>
      {/* scroll area: isolate overflow so Dialog's overflow-hidden doesn't clip it */}
      <div className="overflow-x-auto px-4 py-3" style={{ overflowX: "auto" }}>
        <code className="block whitespace-nowrap font-mono text-xs text-foreground">{code}</code>
      </div>
      {/* copy button: outside scroll area, always visible, same vertical padding */}
      <button
        type="button"
        onClick={copy}
        aria-label="Copy"
        className="flex items-center px-4 py-3 text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
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
export function PairDeviceDialog({ open, onOpenChange, onConnectorCreated }: Props) {
  const [step, setStep] = React.useState<Step>("name")
  const [name, setName] = React.useState(randomName)
  const [connectorId, setConnectorId] = React.useState<string | null>(null)
  const [token, setToken] = React.useState<string | null>(null)
  const [pairCode, setPairCode] = React.useState<string[]>(Array(6).fill(""))
  const pairCodeBoxRefs = React.useRef<(HTMLInputElement | null)[]>([])
  const [creating, setCreating] = React.useState(false)
  const [claiming, setClaiming] = React.useState(false)
  const [polling, setPolling] = React.useState(false)
  const [exitGuardOpen, setExitGuardOpen] = React.useState(false)
  const pollingRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Stable device-created guard: once connector exists, closing needs confirmation
  const deviceCreated = connectorId !== null && step !== "success"

  const stopPolling = () => {
    if (pollingRef.current) clearTimeout(pollingRef.current)
    pollingRef.current = null
    setPolling(false)
  }

  const startPolling = React.useCallback((cid: string) => {
    setPolling(true)
    const tick = async () => {
      try {
        const { online } = await pollConnectorOnline("mock-token", cid)
        if (online) {
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
  }, [onConnectorCreated])

  React.useEffect(() => {
    return () => stopPolling()
  }, [])

  const reset = () => {
    stopPolling()
    setStep("name")
    setName(randomName())
    setConnectorId(null)
    setToken(null)
    setPairCode(Array(6).fill(""))
    setCreating(false)
    setClaiming(false)
    setPolling(false)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && deviceCreated) {
      setExitGuardOpen(true)
      return
    }
    if (!next) reset()
    onOpenChange(next)
  }

  const handleCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      const result = await createConnector("mock-token", { name: name.trim() })
      setConnectorId(result.connectorId)
      setToken(result.token)
      setStep("method")
    } finally {
      setCreating(false)
    }
  }

  const handleSelectToken = () => {
    setStep("token")
    startPolling(connectorId!)
  }

  const handleSelectPairCode = async () => {
    await getPairCode("mock-token", connectorId!)
    setStep("paircode")
  }

  const handleClaim = async () => {
    const code = pairCode.join("")
    if (code.length < 6) return
    setClaiming(true)
    try {
      await claimConnector("mock-token", connectorId!, code)
      startPolling(connectorId!)
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

  // Build the pairing command from connectorId + token
  const tokenCommand = connectorId && token
    ? `agents-anywhere-connector pair --id ${connectorId} --token ${token}`
    : ""

  const pairCodeCommand = connectorId
    ? `agents-anywhere-connector pair --id ${connectorId}`
    : ""

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">

          {/* ── Step: Name ── */}
          {step === "name" && (
            <>
              <DialogHeader>
                <DialogTitle>Name your device</DialogTitle>
                <DialogDescription>
                  Give this device a name so you can identify it later.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2 py-2">
                <Label htmlFor="device-name">Device name</Label>
                <Input
                  id="device-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. amber-finch"
                  className="font-mono"
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button onClick={handleCreate} disabled={!name.trim() || creating} className="w-full">
                  {creating && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Create device
                </Button>
              </DialogFooter>
            </>
          )}

          {/* ── Step: Method ── */}
          {step === "method" && (
            <>
              <DialogHeader>
                <DialogTitle>Choose pairing method</DialogTitle>
                <DialogDescription>
                  How would you like to connect <span className="font-medium text-foreground font-mono">{name}</span> to this instance?
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3 py-2">
                <button
                  type="button"
                  onClick={handleSelectToken}
                  className="flex flex-col gap-0.5 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent"
                >
                  <span className="font-medium">Use token</span>
                  <span className="text-sm text-muted-foreground">Run one command with a pre-authenticated token. No manual input needed on the device.</span>
                </button>
                <button
                  type="button"
                  onClick={handleSelectPairCode}
                  className="flex flex-col gap-0.5 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent"
                >
                  <span className="font-medium">Use pair code</span>
                  <span className="text-sm text-muted-foreground">Run a command on the device, then enter the 6-character code it generates here.</span>
                </button>
              </div>
            </>
          )}

          {/* ── Step: Token ── */}
          {step === "token" && (
            <>
              <DialogHeader>
                <DialogTitle>Pair with token</DialogTitle>
                <DialogDescription>
                  Run this command on <span className="font-medium text-foreground font-mono">{name}</span>. The device will come online automatically.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3 py-2">
                <CodeBlock code={tokenCommand} />
                <PollingIndicator label="Waiting for device to come online…" />
              </div>
              <DialogFooter>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { stopPolling(); setStep("method") }}
                  className="gap-1.5"
                >
                  <ArrowLeft className="size-3.5" />
                  Back
                </Button>
              </DialogFooter>
            </>
          )}

          {/* ── Step: Pair code ── */}
          {step === "paircode" && (
            <>
              <DialogHeader>
                <DialogTitle>Pair with code</DialogTitle>
                <DialogDescription>
                  Run this command on <span className="font-medium text-foreground font-mono">{name}</span>, then enter the 6-character code it outputs.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-2">
                <CodeBlock code={pairCodeCommand} />
                <div className="flex flex-col gap-2">
                  <Label>Pair code from device</Label>
                  <div className="flex items-center gap-2">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <input
                        key={i}
                        ref={(el) => { pairCodeBoxRefs.current[i] = el }}
                        type="text"
                        inputMode="numeric"
                        maxLength={1}
                        value={pairCode[i]}
                        disabled={polling}
                        aria-label={`Pair code digit ${i + 1}`}
                        onChange={(e) => {
                          const val = e.target.value.replace(/\D/g, "").slice(-1)
                          const next = [...pairCode]
                          next[i] = val
                          setPairCode(next)
                          if (val && i < 5) pairCodeBoxRefs.current[i + 1]?.focus()
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Backspace" && !pairCode[i] && i > 0) {
                            pairCodeBoxRefs.current[i - 1]?.focus()
                          }
                        }}
                        onPaste={(e) => {
                          e.preventDefault()
                          const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6)
                          const next = Array(6).fill("")
                          for (let j = 0; j < text.length; j++) next[j] = text[j]
                          setPairCode(next)
                          const focusIdx = Math.min(text.length, 5)
                          pairCodeBoxRefs.current[focusIdx]?.focus()
                        }}
                        className={cn(
                          "h-12 w-full rounded-md border border-border bg-background text-center font-mono text-xl font-medium",
                          "caret-transparent outline-none ring-offset-background",
                          "focus:border-ring focus:ring-2 focus:ring-ring focus:ring-offset-2",
                          "disabled:opacity-40",
                          polling && "opacity-40",
                        )}
                      />
                    ))}
                  </div>
                </div>
                {polling && <PollingIndicator label="Confirming pairing, waiting for device…" />}
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
                  Back
                </Button>
                <Button
                  onClick={handleClaim}
                  disabled={pairCode.join("").length < 6 || claiming || polling}
                  className="flex-1"
                >
                  {claiming && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Claim
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
                  Device paired
                </DialogTitle>
                <DialogDescription>
                  <span className="font-mono font-medium text-foreground">{name}</span> is now online and ready to run sessions.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button onClick={handleSuccessClose} className="w-full">Done</Button>
              </DialogFooter>
            </>
          )}

        </DialogContent>
      </Dialog>

      {/* Exit guard */}
      <AlertDialog open={exitGuardOpen} onOpenChange={setExitGuardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Device already created</AlertDialogTitle>
            <AlertDialogDescription>
              The device <span className="font-mono font-medium text-foreground">{name}</span> has been created but is not yet paired. If you no longer need it, please delete it manually from the Devices list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continue pairing</AlertDialogCancel>
            <AlertDialogAction onClick={handleForceClose}>
              Close anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
