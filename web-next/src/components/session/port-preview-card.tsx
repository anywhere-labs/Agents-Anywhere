"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import QRCode from "qrcode"
import { Copy, ExternalLink, Globe, Loader2, Smartphone, Square, TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { isApiError } from "@/lib/api/errors"
import { runtimeFailureOf, useRuntimeErrorText } from "@/lib/runtime-error-text"
import { copyText } from "@/lib/clipboard"
import { previewApi, type PreviewView } from "@/features/preview/api"
import { localPortUrl, type ListeningPort } from "@/features/preview/session-ports"

/**
 * Preview failures with no runtime-errors entry yet. Contract codes
 * (`preview_limit_reached`, `preview_port_not_allowed`, …) use runtimeErrors.
 */
const PREVIEW_ONLY_ERROR_CODES = new Set(["preview_unavailable", "connector_offline"])
/** The instance has no preview domain: hide the card instead of failing each click. */
const PREVIEW_NOT_CONFIGURED = "preview_domain_not_configured"

type PortState = { phase: "idle" } | { phase: "opening" } | { phase: "open"; view: PreviewView } | { phase: "error"; message: string }

/**
 * "检测到 http://localhost:5173 · 在手机上预览" (09-port-preview.md §5.2, PV-5).
 * Rendered only when this session's processes listen on a port and the
 * instance has port preview (no preview domain → the API answers 404 and the
 * card hides itself for the rest of the visit).
 */
export function PortPreviewCard({
  token,
  sessionId,
  deviceId,
  ports,
  canPreview,
}: {
  token: string
  sessionId: string
  deviceId: string
  ports: ReadonlyMap<number, ListeningPort>
  canPreview: boolean
}) {
  const t = useTranslations("portPreview")
  const runtimeErrorText = useRuntimeErrorText()
  const [states, setStates] = React.useState<ReadonlyMap<number, PortState>>(new Map())
  const [disabled, setDisabled] = React.useState(false)
  const [shown, setShown] = React.useState<number | null>(null)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const setPort = React.useCallback((port: number, state: PortState) => {
    if (mounted.current) setStates(current => new Map(current).set(port, state))
  }, [])

  const errorText = React.useCallback((error: unknown) => {
    const failure = runtimeFailureOf(error)
    if (failure.code && PREVIEW_ONLY_ERROR_CODES.has(failure.code)) return t(`errors.${failure.code}`)
    return runtimeErrorText(failure, t("errors.failed")) ?? t("errors.failed")
  }, [runtimeErrorText, t])

  const open = React.useCallback(async (port: number) => {
    setPort(port, { phase: "opening" })
    try {
      const view = await previewApi.create(token, { deviceId, port, sessionId, visibility: "private" })
      setPort(port, { phase: "open", view })
      setShown(port)
    } catch (error) {
      if (isApiError(error) && (error.status === 404 || error.code === PREVIEW_NOT_CONFIGURED)) {
        if (mounted.current) setDisabled(true)
        return
      }
      setPort(port, { phase: "error", message: errorText(error) })
    }
  }, [deviceId, errorText, sessionId, setPort, token])

  const stop = React.useCallback(async (port: number, view: PreviewView) => {
    try {
      await previewApi.close(token, view.previewId)
      setPort(port, { phase: "idle" })
      if (mounted.current) setShown(null)
    } catch (error) {
      toast.error(errorText(error))
    }
  }, [errorText, setPort, token])

  const visible = [...ports.values()].sort((a, b) => a.port - b.port).slice(0, 3)
  if (disabled || visible.length === 0) return null
  const shownState = shown === null ? undefined : states.get(shown)

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-2" data-testid="port-preview-card">
      <div className="flex flex-col gap-1.5 rounded-2xl border bg-card px-3 py-2 text-sm">
        {visible.map(port => {
          const state = states.get(port.port) ?? { phase: "idle" as const }
          return (
            <div key={port.port} className="flex min-w-0 flex-wrap items-center gap-2">
              <Globe className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {t("detected")} <span className="code-mono">{localPortUrl(port)}</span>
              </span>
              {state.phase === "open" ? (
                <Button size="sm" variant="outline" onClick={() => setShown(port.port)}>
                  <Smartphone data-icon="inline-start" />{t("showPreview")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={!canPreview || state.phase === "opening"} onClick={() => void open(port.port)}>
                  {state.phase === "opening" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Smartphone data-icon="inline-start" />}
                  {t("previewOnPhone")}
                </Button>
              )}
              {state.phase === "error" ? <p className="w-full text-xs text-destructive">{state.message}</p> : null}
            </div>
          )
        })}
      </div>
      {shown !== null && shownState?.phase === "open" ? (
        <PreviewDialog
          token={token}
          view={shownState.view}
          onClose={() => setShown(null)}
          onStop={() => void stop(shown, shownState.view)}
        />
      ) : null}
    </div>
  )
}

function PreviewDialog({ token, view, onClose, onStop }: { token: string; view: PreviewView; onClose: () => void; onStop: () => void }) {
  const t = useTranslations("portPreview")
  const [qr, setQr] = React.useState<string | null>(null)
  const [opening, setOpening] = React.useState(false)
  React.useEffect(() => {
    let current = true
    if (!view.url) return
    // The phone opens the preview URL itself: logged-in AA apps get a ticket,
    // a plain browser signs in first (09-port-preview.md §5.3).
    void QRCode.toDataURL(view.url, { margin: 1, width: 220 }).then(image => { if (current) setQr(image) }, () => undefined)
    return () => { current = false }
  }, [view.url])

  const openHere = async () => {
    setOpening(true)
    try {
      // A one-time ticket turns into the preview domain's own cookie.
      const ticket = await previewApi.ticket(token, view.previewId)
      window.open(ticket.ticketUrl, "_blank", "noopener,noreferrer")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.failed"))
    } finally {
      setOpening(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent data-testid="port-preview-dialog">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle", { port: view.port })}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        {view.state !== "open" || !view.url ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("opening")}</p>
        ) : (
          <div className="flex flex-col items-center gap-3">
            {qr ? <img src={qr} alt={t("qrAlt")} className="size-[220px] rounded-lg bg-white p-1" /> : <div className="size-[220px]" />}
            <div className="flex w-full min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5">
              <span className="code-mono min-w-0 flex-1 truncate text-xs">{view.url}</span>
              <Button size="icon-sm" variant="ghost" aria-label={t("copy")} onClick={() => void copyText(view.url!).then(() => toast.success(t("copied")))}>
                <Copy />
              </Button>
            </div>
          </div>
        )}
        {view.plaintextNotice ? (
          <Alert>
            <TriangleAlert />
            <AlertTitle>{t("plaintextTitle")}</AlertTitle>
            <AlertDescription>{t("plaintextDescription")}</AlertDescription>
          </Alert>
        ) : null}
        <p className="text-xs text-muted-foreground">{t("limitations")}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onStop}><Square data-icon="inline-start" />{t("stop")}</Button>
          <Button disabled={opening || view.state !== "open"} onClick={() => void openHere()}>
            {opening ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <ExternalLink data-icon="inline-start" />}{t("openHere")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
