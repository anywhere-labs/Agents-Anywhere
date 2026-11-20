"use client"

import * as React from "react"
import { QrCode, RefreshCw } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import QRCode from "qrcode"
import { toast } from "sonner"

import type { ClientPairingResult } from "../../../../shared/client-pairing"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import { copyText } from "@/lib/clipboard"

type PairingCode = { image: string; uri: string; fingerprint: string; expiresAt: number }
type CodeState =
  | { phase: "loading"; pairing?: PairingCode }
  | { phase: "error"; code: Extract<ClientPairingResult, { ok: false }>["code"]; pairing?: PairingCode }
  | { phase: "ready" | "expired"; pairing: PairingCode }

export function MobilePairingCode() {
  const t = useTranslations("e2ee.mobilePairing")
  const format = useFormatter()
  const [state, setState] = React.useState<CodeState | null>(null)
  const pairing = state?.pairing
  const request = React.useRef(0)
  const connector = getDesktopWorkbenchBridge()?.connector

  React.useEffect(() => () => { request.current++ }, [])
  React.useEffect(() => {
    if (state?.phase !== "ready") return
    const checkExpiry = () => {
      if (Date.now() >= state.pairing.expiresAt) {
        setState(current => current === state ? { phase: "expired", pairing: state.pairing } : current)
      }
    }
    const timer = window.setTimeout(checkExpiry, Math.max(0, state.pairing.expiresAt - Date.now()))
    window.addEventListener("focus", checkExpiry)
    document.addEventListener("visibilitychange", checkExpiry)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("focus", checkExpiry)
      document.removeEventListener("visibilitychange", checkExpiry)
    }
  }, [state])

  async function showCode(previous?: PairingCode) {
    if (!connector) return
    const current = ++request.current
    setState({ phase: "loading", pairing: previous })
    try {
      const result = await connector.startClientPairing()
      if (current !== request.current) return
      if (!result.ok) {
        setState({ phase: "error", code: result.code, pairing: previous })
        return
      }
      const image = await QRCode.toDataURL(result.uri, { margin: 4, scale: 6 })
      if (current !== request.current) return
      const expiresAt = Date.parse(result.expiresAt)
      setState({
        phase: expiresAt > Date.now() ? "ready" : "expired",
        pairing: { image, uri: result.uri, fingerprint: result.fingerprint, expiresAt },
      })
    } catch {
      if (current === request.current) setState({ phase: "error", code: "not_available", pairing: previous })
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
        {state?.phase === "loading" && !pairing && <p role="status">{t("loading")}</p>}
        {state && pairing && (
          <div className="flex min-w-0 flex-col items-center gap-3 text-center">
            <div className="relative w-80 max-w-full">
              <img src={pairing.image} alt={state.phase === "ready" ? t("title") : ""} width={320} height={320}
                className="block h-auto w-full [image-rendering:pixelated]" />
              {state.phase !== "ready" && (
                <button type="button" disabled={state.phase === "loading"} onClick={() => void showCode(pairing)}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 font-medium text-white backdrop-blur-[2px] enabled:cursor-pointer enabled:hover:bg-black/85 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white">
                  <RefreshCw aria-hidden className={state.phase === "loading" ? "size-6 motion-safe:animate-spin" : "size-6"} />
                  {t(state.phase === "loading" ? "loading" : "refresh")}
                </button>
              )}
            </div>
            <div>{t("fingerprint")} <span className="font-mono font-medium">{pairing.fingerprint}</span></div>
            <p role="status" className="text-muted-foreground">
              {state.phase === "ready" ? t("validUntil", { time: format.dateTime(pairing.expiresAt, { timeStyle: "short" }) }) : t("expired")}
            </p>
          </div>
        )}
        {state?.phase === "error" && <p role="alert">{t(state.code)}</p>}
        <DialogFooter>
          {pairing && (
            <Button variant="outline" disabled={state?.phase !== "ready"} onClick={() => {
              if (Date.now() >= pairing.expiresAt) {
                setState({ phase: "expired", pairing })
                return
              }
              void copyText(pairing.uri).then(() => toast.success(t("copied")), () => toast.error(t("copyFailed")))
            }}>{t("copyLink")}</Button>
          )}
          {state?.phase === "error" && !pairing && <Button onClick={() => void showCode()}>{t("retry")}</Button>}
          <DialogClose asChild><Button variant="outline">{t("close")}</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
