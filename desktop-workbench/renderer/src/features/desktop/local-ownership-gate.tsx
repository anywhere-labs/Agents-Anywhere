"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Check, Copy, FolderOpen } from "lucide-react"
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loading-state"
import { copyText } from "@/lib/clipboard"
import { getDesktopWorkbenchBridge, type LocalOwnershipState } from "./bridge"
import { LocalOwnershipContext } from "./local-ownership-context"

/**
 * Mount before auth/provisioning, so a second Connector cannot rotate credentials.
 *
 * Only what Desktop cannot coexist with blocks: a v2 or unknown Connector
 * (`conflict`), a failed check or a stopped backend (`error`). A newer
 * Connector serving this computer (`external`) lets the app through like
 * `owned`; the provider tells the local Connector UI, and the same tree stays
 * mounted when Desktop takes the machine back.
 */
export function LocalOwnershipGate({ children }: { children: ReactNode }) {
  const t = useTranslations("localOwnership")
  const [state, setState] = useState<LocalOwnershipState | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

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

  if (state?.status === "owned" || state?.status === "external") {
    return <LocalOwnershipContext.Provider value={state}>{children}</LocalOwnershipContext.Provider>
  }
  if (!state || state.status === "checking") {
    return <LoadingState className="min-h-screen bg-background" label={t("checkingConnector")} />
  }

  const recheck = async () => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.ownership || busy) return
    setBusy(true)
    setCopied(false)
    setActionError(null)
    try { setState(await bridge.ownership.recheck()) }
    catch (error) { setActionError(errorMessage(error)) }
    finally { setBusy(false) }
  }
  const conflict = state.status === "conflict"
  const backendStopped = state.recovery?.kind === "backendStopped"
  const detail = state.message?.trim() ?? ""
  const connector = getDesktopWorkbenchBridge()?.connector
  const copyDetail = async () => {
    try { await copyText(detail); setCopied(true) }
    catch { /* The detail stays selectable. */ }
  }
  const title = conflict ? "title" : backendStopped ? "backendStoppedTitle" : "errorTitle"
  const description = conflict ? "description"
    : backendStopped ? "backendStoppedDescription"
    : detail ? "errorDescription" : "errorWithoutDetail"

  return <div className="min-h-screen bg-background">
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent onEscapeKeyDown={event => event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(title)}</AlertDialogTitle>
          <AlertDialogDescription>{t(description)}</AlertDialogDescription>
        </AlertDialogHeader>
        {detail || connector?.openLogsFolder ? <div className="grid min-w-0 gap-2">
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
        </div> : null}
        {actionError ? <p className="text-sm text-destructive select-text">{actionError}</p> : null}
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => void getDesktopWorkbenchBridge()?.ownership?.quit()}>{t("quit")}</Button>
          <Button disabled={busy} onClick={() => void recheck()}>
            {t(busy ? "checking" : backendStopped ? "restartBackend" : "recheck")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

/** A bridge call that fails is itself the error to show. */
function failedState(error: unknown): LocalOwnershipState {
  return { status: "error", message: errorMessage(error) }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
