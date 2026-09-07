"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loading-state"
import { getDesktopWorkbenchBridge, type LocalOwnershipState } from "./bridge"

/** Mount before auth/provisioning, so a second Connector cannot rotate credentials. */
export function LocalOwnershipGate({ children }: { children: ReactNode }) {
  const t = useTranslations("localOwnership")
  const [state, setState] = useState<LocalOwnershipState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const api = getDesktopWorkbenchBridge()?.ownership
    if (!api) { setState({ status: "owned" }); return }
    let active = true
    let revision = 0
    const unsubscribe = api.onState(next => { revision++; if (active) setState(next) })
    const initialRevision = revision
    void api.getState().then(next => { if (active && revision === initialRevision) setState(next) })
      .catch(() => { if (active) setState({ status: "error" }) })
    return () => { active = false; unsubscribe() }
  }, [])

  if (state?.status === "owned") return children
  if (!state) return <LoadingState className="min-h-screen bg-background" />

  const recheck = async () => {
    const api = getDesktopWorkbenchBridge()?.ownership
    if (!api || busy) return
    setBusy(true)
    try { setState(await api.recheck()) }
    catch { setState({ status: "error" }) }
    finally { setBusy(false) }
  }

  return <div className="min-h-screen bg-background">
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent onEscapeKeyDown={event => event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(state.status === "conflict" ? "title" : "errorTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t(state.status === "conflict" ? "description" : "errorDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => void getDesktopWorkbenchBridge()?.ownership?.quit()}>{t("quit")}</Button>
          <Button disabled={busy} onClick={() => void recheck()}>{t(busy ? "checking" : "recheck")}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}
