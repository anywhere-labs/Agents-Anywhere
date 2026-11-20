"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import type { AuthorizedClient, AuthorizedClients, ClientGrantSelection } from "../../../../shared/client-pairing"
import { SettingsSection } from "@/components/settings/settings-section"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"

export function AuthorizedClientList() {
  const t = useTranslations("e2ee.authorizedClients")
  const settings = useTranslations("e2ee.settings")
  const connector = getDesktopWorkbenchBridge()?.connector
  const [view, setView] = React.useState<AuthorizedClients | null>(null)
  const [selected, setSelected] = React.useState<(AuthorizedClient & ClientGrantSelection) | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const sequence = React.useRef(0)
  const inFlight = React.useRef(false)

  const load = React.useCallback(async (background = false) => {
    if (!connector || inFlight.current) return
    inFlight.current = true
    const id = ++sequence.current
    if (!background) setBusy(true)
    try {
      const next = await connector.listClientGrants()
      if (id === sequence.current) { setView(next); setFailed(false) }
    } catch {
      if (id === sequence.current) { setView(null); setFailed(true) }
    } finally {
      if (id === sequence.current) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }, [connector])

  React.useEffect(() => {
    void load()
    const refreshVisible = () => { if (!document.hidden) void load(true) }
    const timer = window.setInterval(refreshVisible, 5000)
    window.addEventListener("focus", refreshVisible)
    document.addEventListener("visibilitychange", refreshVisible)
    return () => {
      sequence.current++
      inFlight.current = false
      window.clearInterval(timer)
      window.removeEventListener("focus", refreshVisible)
      document.removeEventListener("visibilitychange", refreshVisible)
    }
  }, [load])

  async function revoke() {
    if (!selected || !connector || busy) return
    const { deviceId, clientId, grantedAt } = selected
    setSelected(null)
    sequence.current++
    inFlight.current = true
    setBusy(true)
    try {
      setView(await connector.revokeClientGrant({ deviceId, clientId, grantedAt }))
      setFailed(false)
      toast.success(t("revoked"))
    } catch {
      toast.error(t("revokeError"))
      setFailed(true)
      setView(null)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (!connector) return null
  return (
    <SettingsSection variant="plain" title={t("title")}
      action={<Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>{t("refresh")}</Button>}>
      {failed && <p role="alert" className="text-sm text-muted-foreground">{t("loadError")}</p>}
      {view?.clients.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
      {view && view.clients.length > 0 && (
        <ul className="divide-y">
          {view.clients.map(client => (
            <li key={client.clientId} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="font-medium">{client.label || client.clientId}</div>
                <div className="break-all font-mono text-xs text-muted-foreground">{client.identityPubFingerprint}</div>
                <div className="text-xs text-muted-foreground">{settings("pairedAt", { time: new Date(client.grantedAt).toLocaleString() })}</div>
              </div>
              <Button variant="outline" size="sm" disabled={busy}
                onClick={() => setSelected({ ...client, deviceId: view.deviceId })}>{t("revoke")}</Button>
            </li>
          ))}
        </ul>
      )}
      <AlertDialog open={!!selected} onOpenChange={open => !open && setSelected(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm", { client: selected?.label || selected?.clientId || "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("detail")} <span className="break-all font-mono">{selected?.identityPubFingerprint}</span></AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{settings("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void revoke()}>{t("revoke")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}
