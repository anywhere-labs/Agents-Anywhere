"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Check, Copy, FolderOpen } from "lucide-react"
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loading-state"
import { copyText } from "@/lib/clipboard"
import { getDesktopWorkbenchBridge, type LocalOwnershipState } from "./bridge"

/** Mount before auth/provisioning, so a second Connector cannot rotate credentials. */
export function LocalOwnershipGate({ children }: { children: ReactNode }) {
  const t = useTranslations("localOwnership")
  const [state, setState] = useState<LocalOwnershipState | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const api = getDesktopWorkbenchBridge()?.ownership
    if (!api) { setState({ status: "owned" }); return }
    let active = true
    let revision = 0
    const unsubscribe = api.onState(next => { revision++; if (active) setState(next) })
    const initialRevision = revision
    void api.getState().then(next => { if (active && revision === initialRevision) setState(next) })
      .catch(error => { if (active) setState(failedState(error)) })
    return () => { active = false; unsubscribe() }
  }, [])

  if (state?.status === "owned") return children
  // `checking` means the first probe has not answered yet.
  if (!state || state.status === "checking") return <LoadingState className="min-h-screen bg-background" label={state ? t("checkingConnector") : undefined} />
  // Building the Connector environment installs every dependency (and, without
  // a bundled interpreter, Python) before the Connector can answer; that is
  // progress, not a failure to report.
  if (state.status === "preparing") return <LoadingState className="min-h-screen bg-background" label={t("preparing")} />

  const recheck = async () => {
    const api = getDesktopWorkbenchBridge()?.ownership
    if (!api || busy) return
    setBusy(true)
    setCopied(false)
    try { setState(await api.recheck()) }
    catch (error) { setState(failedState(error)) }
    finally { setBusy(false) }
  }

  const conflict = state.status === "conflict"
  // The conflict copy names its cause; any other failure quotes the error itself.
  const detail = conflict ? "" : state.message?.trim() ?? ""
  const connector = getDesktopWorkbenchBridge()?.connector
  const copyDetail = async () => {
    try { await copyText(detail); setCopied(true) }
    catch { /* The detail stays selectable. */ }
  }

  return <div className="min-h-screen bg-background">
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent onEscapeKeyDown={event => event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(conflict ? "title" : "errorTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t(conflict ? "description" : detail ? "errorDescription" : "errorWithoutDetail")}</AlertDialogDescription>
        </AlertDialogHeader>
        {conflict ? null : <div className="grid min-w-0 gap-2">
          {detail ? <pre className="code-mono max-h-48 overflow-auto rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words select-text">{detail}</pre> : null}
          <div className="flex flex-wrap gap-2">
            {detail ? <Button variant="outline" size="sm" onClick={() => void copyDetail()}>
              {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
              {t(copied ? "copied" : "copyError")}
            </Button> : null}
            {connector?.openLogsFolder ? <Button variant="outline" size="sm" onClick={() => void connector.openLogsFolder?.()}>
              <FolderOpen data-icon="inline-start" />
              {t("openLogs")}
            </Button> : null}
          </div>
        </div>}
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => void getDesktopWorkbenchBridge()?.ownership?.quit()}>{t("quit")}</Button>
          <Button disabled={busy} onClick={() => void recheck()}>{t(busy ? "checking" : "recheck")}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

/** A bridge call that fails is itself the error to show. */
function failedState(error: unknown): LocalOwnershipState {
  return { status: "error", message: error instanceof Error ? error.message : String(error) }
}
