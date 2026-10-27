"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Check, Copy, FolderOpen } from "lucide-react"
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldGroup } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LoadingState } from "@/components/loading-state"
import { copyText } from "@/lib/clipboard"
import { getDesktopWorkbenchBridge, type LocalOwnershipRecovery, type LocalOwnershipState } from "./bridge"
import { PYPI_MIRROR_OPTIONS, PYTHON_MIRROR_OPTIONS } from "./package-mirrors"

type ProvisioningRecovery = Extract<LocalOwnershipRecovery, { kind: "provisioning" }>

/** Mount before auth/provisioning, so a second Connector cannot rotate credentials. */
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

  if (state?.status === "owned") return children
  // `checking` means the first probe has not answered yet.
  if (!state || state.status === "checking") return <LoadingState className="min-h-screen bg-background" label={state ? t("checkingConnector") : undefined} />
  // Building the Connector environment installs every dependency (and, without
  // a bundled interpreter, Python) before the Connector can answer; that is
  // progress, not a failure to report.
  if (state.status === "preparing") return <LoadingState className="min-h-screen bg-background" label={t("preparing")} />

  const run = async (action: (api: NonNullable<ReturnType<typeof getDesktopWorkbenchBridge>>) => Promise<LocalOwnershipState | void>) => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.ownership || busy) return
    setBusy(true)
    setCopied(false)
    setActionError(null)
    try {
      const next = await action(bridge)
      if (next) setState(next)
    } catch (error) {
      setActionError(errorMessage(error))
    } finally { setBusy(false) }
  }
  const recheck = () => run(bridge => bridge.ownership!.recheck())
  // Clearing first stops the half-built environment, so the recheck downloads everything again.
  const resetAndRecheck = () => run(async bridge => {
    await bridge.ownership!.resetEnvironment!()
    return bridge.ownership!.recheck()
  })

  const conflict = state.status === "conflict"
  const provisioning = state.recovery?.kind === "provisioning" ? state.recovery : null
  const backendStopped = state.recovery?.kind === "backendStopped"
  const detail = state.message?.trim() ?? ""
  const connector = getDesktopWorkbenchBridge()?.connector
  const canReset = Boolean(provisioning && getDesktopWorkbenchBridge()?.ownership?.resetEnvironment)
  const copyDetail = async () => {
    try { await copyText(detail); setCopied(true) }
    catch { /* The detail stays selectable. */ }
  }
  const title = conflict ? "title" : provisioning ? "provisioningTitle" : backendStopped ? "backendStoppedTitle" : "errorTitle"
  const description = conflict ? "description"
    : provisioning ? "provisioningDescription"
    : backendStopped ? "backendStoppedDescription"
    : detail ? "errorDescription" : "errorWithoutDetail"

  return <div className="min-h-screen bg-background">
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent onEscapeKeyDown={event => event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(title)}</AlertDialogTitle>
          <AlertDialogDescription>{t(description)}</AlertDialogDescription>
        </AlertDialogHeader>
        {provisioning ? <MirrorChoices recovery={provisioning} disabled={busy} onError={setActionError} /> : null}
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
          {canReset ? <Button variant="outline" disabled={busy} onClick={() => void resetAndRecheck()}>{t("resetEnvironment")}</Button> : null}
          <Button disabled={busy} onClick={() => void recheck()}>
            {t(busy ? "checking" : provisioning ? "retry" : backendStopped ? "restartBackend" : "recheck")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

/**
 * The same choices as Settings → Advanced, which the gate keeps out of reach
 * until the environment exists. Each change is saved at once and used by the
 * next retry.
 */
function MirrorChoices({ recovery, disabled, onError }: {
  recovery: ProvisioningRecovery
  disabled: boolean
  onError: (message: string | null) => void
}) {
  const t = useTranslations("localOwnership")
  const labels = useTranslations("pages.settings")
  const [pypi, setPypi] = useState(recovery.pypiIndexUrl)
  const [python, setPython] = useState(recovery.pythonInstallMirror)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setPypi(recovery.pypiIndexUrl) }, [recovery.pypiIndexUrl])
  useEffect(() => { setPython(recovery.pythonInstallMirror) }, [recovery.pythonInstallMirror])

  const save = async (patch: { uvPypiIndexUrl?: string; uvPythonInstallMirror?: string }, revert: () => void) => {
    const connector = getDesktopWorkbenchBridge()?.connector
    if (!connector) return
    setSaving(true)
    onError(null)
    try { await connector.saveSettings(patch) }
    catch (error) { revert(); onError(errorMessage(error)) }
    finally { setSaving(false) }
  }
  // A saved URL outside the presets keeps its value; the trigger then shows it as is.
  const pypiValue = pypi || "default"
  const pythonValue = python || "default"

  return <FieldGroup className="gap-3">
    <Field orientation="horizontal">
      <FieldContent>
        <span className="text-sm font-medium">{labels("desktopUvPypiIndexUrl")}</span>
        <span className="text-xs text-muted-foreground">{t("pypiMirrorHint")}</span>
      </FieldContent>
      <Select value={pypiValue} disabled={disabled || saving} onValueChange={value => {
        const previous = pypi
        const next = value === "default" ? "" : value
        setPypi(next)
        void save({ uvPypiIndexUrl: next }, () => setPypi(previous))
      }}>
        <SelectTrigger className="min-w-36"><SelectValue /></SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            {PYPI_MIRROR_OPTIONS.some(option => (option.url || "default") === pypiValue)
              ? null
              : <SelectItem value={pypiValue}>{pypiValue}</SelectItem>}
            {PYPI_MIRROR_OPTIONS.map(option => <SelectItem key={option.id} value={option.url || "default"}>{labels(option.labelKey)}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
    {recovery.downloadsPython ? <Field orientation="horizontal">
      <FieldContent>
        <span className="text-sm font-medium">{labels("desktopUvPythonInstallMirror")}</span>
      </FieldContent>
      <Select value={pythonValue} disabled={disabled || saving} onValueChange={value => {
        const previous = python
        const next = value === "default" ? "" : value
        setPython(next)
        void save({ uvPythonInstallMirror: next }, () => setPython(previous))
      }}>
        <SelectTrigger className="min-w-36"><SelectValue /></SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            {PYTHON_MIRROR_OPTIONS.some(option => (option.url || "default") === pythonValue)
              ? null
              : <SelectItem value={pythonValue}>{pythonValue}</SelectItem>}
            {PYTHON_MIRROR_OPTIONS.map(option => <SelectItem key={option.id} value={option.url || "default"}>{labels(option.labelKey)}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field> : null}
  </FieldGroup>
}

/** A bridge call that fails is itself the error to show. */
function failedState(error: unknown): LocalOwnershipState {
  return { status: "error", message: errorMessage(error) }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
