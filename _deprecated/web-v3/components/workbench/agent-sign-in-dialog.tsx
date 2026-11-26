"use client"

// Signing in to an agent on a device, from wherever it refused to start (its row and settings on the device page, a new
// conversation). The agent names the ways: it does it itself when asked to (it may open a browser on the device, so the
// wait can be long and can be cancelled), or its own program does it in a terminal, shown here. One way that needs no
// terminal is started at once; `onSignedIn` is told when it is done.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LoaderCircleIcon, TerminalIcon } from "lucide-react"
import { MeshCallError } from "meshcall/web"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { TerminalView } from "@/components/terminal/terminal-view"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AgentIcon } from "@/components/workbench/agent-icon"
import { Card, Row } from "@/components/workbench/settings-parts"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import { clientLabel } from "@/lib/terminal/label"
import { createMeshTerminalTransport } from "@/lib/terminal/mesh-transport"
import type { DeviceRecord, SignInMethod, TerminalInfo } from "@/lib/types/v3"
import { untilAnswered } from "@/lib/workbench/sign-in"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

export interface SignInTarget {
  id: string
  name: string
  methods: SignInMethod[]
}

export function AgentSignInDialog({
  target,
  onClose,
  tunnelManager,
  device,
  onSignedIn,
}: {
  /** The agent to sign in to; null: closed. */
  target: SignInTarget | null
  onClose: () => void
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  onSignedIn: (agent: string) => void
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(760px,calc(100dvh-4rem))] flex-col gap-0 p-0 sm:max-w-xl">
        {target && tunnelManager && device && (
          <SignInBody
            key={`${device.id}:${target.id}`}
            target={target}
            tunnelManager={tunnelManager}
            device={device}
            onClose={onClose}
            onSignedIn={onSignedIn}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SignInBody({
  target,
  tunnelManager,
  device,
  onClose,
  onSignedIn,
}: {
  target: SignInTarget
  tunnelManager: DeviceTunnelManager
  device: TunnelDevice
  onClose: () => void
  onSignedIn: (agent: string) => void
}) {
  const { t } = useI18n()
  const [waiting, setWaiting] = useState(false)
  const [terminal, setTerminal] = useState<TerminalInfo | null>(null)
  const [opening, setOpening] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const open = useRef(true)
  const waitingRef = useRef(false)
  const terminalRef = useRef<string | null>(null)
  const label = useMemo(() => clientLabel(navigator.userAgent), [])
  const transport = useMemo(() => createMeshTerminalTransport(tunnelManager, device), [device, tunnelManager])

  const done = useCallback(() => {
    toast.success(t("agentSignIn.done", { agent: target.name }))
    onSignedIn(target.id)
    onClose()
  }, [onClose, onSignedIn, t, target])

  const signIn = async (method: SignInMethod) => {
    setFailure(null)
    setWaiting(true)
    waitingRef.current = true
    try {
      await untilAnswered(() => tunnelManager.signInAgent(device, target.id, method.id))
      waitingRef.current = false
      if (open.current) done()
    } catch (err) {
      waitingRef.current = false
      if (!open.current) return
      setWaiting(false)
      if (!(err instanceof MeshCallError && err.reason === "sign_in_cancelled")) setFailure(err instanceof Error ? err.message : String(err))
    }
  }

  const openTerminal = async (method: SignInMethod) => {
    setFailure(null)
    setOpening(true)
    try {
      const created = await tunnelManager.signInTerminal(device, target.id, method.id)
      if (!open.current) {
        void tunnelManager.closeTerminal(device, created.id).catch(() => undefined)
        return
      }
      terminalRef.current = created.id
      setTerminal(created)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  const closeTerminal = useCallback(() => {
    const id = terminalRef.current
    terminalRef.current = null
    if (id) void tunnelManager.closeTerminal(device, id).catch(() => undefined)
  }, [device, tunnelManager])

  const onTerminalExit = useCallback(
    (exit: { code: number | null }) => {
      if (exit.code === 0) done()
      else setFailure(t("agentSignIn.exited", { code: exit.code ?? "?" }))
    },
    [done, t]
  )

  // Closing the dialog ends what it started. (Delayed: effects run twice in development.)
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
      window.setTimeout(() => {
        if (open.current) return
        if (waitingRef.current) void tunnelManager.cancelSignIn(device, target.id).catch(() => undefined)
        closeTerminal()
      }, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One way that needs no terminal: the click that opened this was the choice.
  const [only] = target.methods.length === 1 ? target.methods : []
  const started = useRef(false)
  useEffect(() => {
    if (only?.kind !== "agent" || started.current) return
    started.current = true
    queueMicrotask(() => void signIn(only))
  })

  return (
    <>
      <DialogHeader className="flex-row items-center gap-3 border-b border-border px-6 py-4 text-left">
        <AgentIcon agent={target.id} name={target.name} className="size-6 shrink-0" />
        <DialogTitle className="min-w-0 truncate">{t("agentSignIn.title", { agent: target.name })}</DialogTitle>
        <DialogDescription className="sr-only">{t("agentSignIn.title", { agent: target.name })}</DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
        {failure && <p className="text-sm break-words text-destructive">{failure}</p>}
        {terminal ? (
          <div className="flex h-[min(56dvh,440px)] flex-col">
            <TerminalView key={terminal.id} info={terminal} transport={transport} initialMode="control" label={label} fill onExit={onTerminalExit} />
          </div>
        ) : waiting ? (
          <div className="flex items-center gap-3 rounded-2xl bg-card px-4 py-3">
            <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />
            <p className="min-w-0 flex-1 text-sm text-foreground">{t("agentSignIn.waiting")}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void tunnelManager.cancelSignIn(device, target.id).catch((err) => toast.error(err instanceof Error ? err.message : String(err)))}
            >
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <Card>
            {target.methods.map((method) => (
              <Row key={method.id} label={method.name} hint={method.description}>
                {method.kind === "agent" ? (
                  <Button variant="outline" size="sm" disabled={opening} onClick={() => void signIn(method)}>
                    {t("agentSignIn.action")}
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled={opening} onClick={() => void openTerminal(method)}>
                    {opening ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <TerminalIcon className="size-3.5" />}
                    {t("agentSignIn.terminal")}
                  </Button>
                )}
              </Row>
            ))}
          </Card>
        )}
      </div>
    </>
  )
}
