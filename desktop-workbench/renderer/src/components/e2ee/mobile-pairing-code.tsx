"use client"

import * as React from "react"
import { QrCode } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import QRCode from "qrcode"
import { toast } from "sonner"

import type { ClientPairingResult } from "../../../../shared/client-pairing"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import { copyText } from "@/lib/clipboard"

type CodeState =
  | { phase: "loading" | "expired" }
  | { phase: "error"; code: Extract<ClientPairingResult, { ok: false }>["code"] }
  | { phase: "ready"; image: string; uri: string; fingerprint: string; expiresAt: number }

export function MobilePairingCode() {
  const t = useTranslations("e2ee.mobilePairing")
  const format = useFormatter()
  const [state, setState] = React.useState<CodeState | null>(null)
  const request = React.useRef(0)
  const connector = getDesktopWorkbenchBridge()?.connector

  React.useEffect(() => () => { request.current++ }, [])
  React.useEffect(() => {
    if (state?.phase !== "ready") return
    const timer = setTimeout(() => setState({ phase: "expired" }), Math.max(0, state.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [state])

  async function showCode() {
    if (!connector) return
    const current = ++request.current
    setState({ phase: "loading" })
    try {
      const result = await connector.startClientPairing()
      if (current !== request.current) return
      if (!result.ok) {
        setState({ phase: "error", code: result.code })
        return
      }
      const image = await QRCode.toDataURL(result.uri, { margin: 4, scale: 6 })
      if (current !== request.current) return
      const expiresAt = Date.parse(result.expiresAt)
      setState(expiresAt > Date.now()
        ? { phase: "ready", image, uri: result.uri, fingerprint: result.fingerprint, expiresAt }
        : { phase: "expired" })
    } catch {
      if (current === request.current) setState({ phase: "error", code: "not_available" })
    }
  }

  if (!connector?.startClientPairing) return null
  return (
    <Dialog open={state !== null} onOpenChange={(open) => {
      if (open) void showCode()
      else {
        request.current++
        setState(null)
      }
    }}>
      <DialogTrigger asChild>
        <Button><QrCode data-icon="inline-start" aria-hidden />{t("show")}</Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("instructions")}</DialogDescription>
        </DialogHeader>
        {state?.phase === "loading" && <p role="status">{t("loading")}</p>}
        {state?.phase === "expired" && <p role="status">{t("expired")}</p>}
        {state?.phase === "error" && <p role="alert">{t(state.code)}</p>}
        {state?.phase === "ready" && (
          <div className="flex min-w-0 flex-col items-center gap-3 text-center">
            <img src={state.image} alt={t("title")} width={320} height={320} className="h-auto w-80 max-w-full [image-rendering:pixelated]" />
            <div>{t("fingerprint")} <span className="font-mono font-medium">{state.fingerprint}</span></div>
            <p className="text-muted-foreground">{t("validUntil", { time: format.dateTime(state.expiresAt, { timeStyle: "short" }) })}</p>
          </div>
        )}
        <DialogFooter>
          {state?.phase === "ready" && (
            <Button variant="outline" onClick={() => void copyText(state.uri).then(
              () => toast.success(t("copied")), () => toast.error(t("copyFailed")),
            )}>{t("copyLink")}</Button>
          )}
          {(state?.phase === "expired" || state?.phase === "error") && <Button onClick={() => void showCode()}>{t("retry")}</Button>}
          <DialogClose asChild><Button variant="outline">{t("close")}</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
