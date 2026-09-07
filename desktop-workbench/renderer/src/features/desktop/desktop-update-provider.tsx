"use client"

import * as React from "react"
import { Download } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useAuth } from "@/components/auth/auth-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { getDesktopWorkbenchBridge, type DesktopUpdateState } from "@/features/desktop/bridge"

type UpdateContext = { state: DesktopUpdateState | null; open: () => void }
const Context = React.createContext<UpdateContext>({ state: null, open: () => undefined })

export function DesktopUpdateProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("desktopUpdates")
  const { session, isAuthenticated, loading, screen } = useAuth()
  const serverUrl = !loading && isAuthenticated && screen === "app" ? session?.serverUrl?.trim() || null : null
  const sessionKey = serverUrl ? `${session?.userId}:${serverUrl}` : null
  const [snapshot, setSnapshot] = React.useState<{ sessionKey: string | null; state: DesktopUpdateState } | null>(null)
  const state = sessionKey && snapshot?.sessionKey === sessionKey ? snapshot.state : null
  const [pending, setPending] = React.useState(false)
  const generation = React.useRef(0)
  const accept = React.useCallback((next: DesktopUpdateState | null) => {
    if (next) setSnapshot((current) => !current || current.sessionKey !== sessionKey || next.revision >= current.state.revision
      ? { sessionKey, state: next } : current)
  }, [sessionKey])

  React.useEffect(() => {
    const updates = getDesktopWorkbenchBridge()?.updates
    if (!updates?.syncSession) return
    ++generation.current
    setPending(false)
    let disposed = false
    const receive = (next: DesktopUpdateState | null) => { if (!disposed) accept(next) }
    const unsubscribe = updates.onState(receive)
    void updates.syncSession(serverUrl).then(receive).catch(() => undefined)
    return () => {
      ++generation.current
      disposed = true
      unsubscribe()
      void updates.syncSession(null).catch(() => undefined)
    }
  }, [accept, serverUrl])

  const perform = React.useCallback(async (action: "open" | "ignore" | "download") => {
    const updates = getDesktopWorkbenchBridge()?.updates
    if (!updates || !serverUrl) return
    const currentGeneration = generation.current
    setPending(true)
    try {
      const next = await updates[action]()
      if (currentGeneration === generation.current) accept(next)
    } catch {
      if (currentGeneration === generation.current) toast.error(t("errors.actionFailed"))
    } finally {
      if (currentGeneration === generation.current) setPending(false)
    }
  }, [accept, serverUrl, t])
  const open = React.useCallback(() => { void perform("open") }, [perform])
  const busy = pending || state?.phase === "downloading" || state?.phase === "opening"
  const progress = state?.totalBytes ? Math.min(100, Math.floor(state.downloadedBytes / state.totalBytes * 100)) : null

  return (
    <Context.Provider value={{ state, open }}>
      {children}
      <Dialog open={Boolean(state?.available && state.dialogOpen)}>
        <DialogContent
          showCloseButton={false}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-4 text-sm">
            <span>{t("currentVersion", { version: state?.currentVersion ?? "" })}</span>
            <span>{t("latestVersion", { version: state?.latestVersion ?? "" })}</span>
          </div>
          {state && (state.phase === "downloading" || state.phase === "opening") ? (
            <div className="flex flex-col gap-2" aria-live="polite">
              <Progress value={progress} aria-label={t("downloading")} />
              <p className="text-sm text-muted-foreground">
                {state.phase === "opening" ? t("opening") : progress === null
                  ? t("downloadedBytes", { size: formatBytes(state.downloadedBytes) })
                  : t("progress", { percent: progress, received: formatBytes(state.downloadedBytes), total: formatBytes(state.totalBytes ?? 0) })}
              </p>
            </div>
          ) : null}
          {state?.error ? <p role="alert" className="text-sm text-destructive">{t(`errors.${state.error}`)}</p> : null}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => void perform("ignore")}>{t("ignore")}</Button>
            <Button disabled={busy} onClick={() => void perform("download")}>
              {busy ? <Spinner /> : <Download data-icon="inline-start" />}
              {t("updateNow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Context.Provider>
  )
}

export function DesktopUpdateButton() {
  const { state, open } = React.useContext(Context)
  const t = useTranslations("desktopUpdates")
  if (!state?.available) return null
  return (
    <Button variant="ghost" size="icon" className="relative shrink-0" onClick={open} title={t("entry")} aria-label={t("entry")}>
      <Download />
      <Badge variant="notification" className="absolute right-1 top-1 size-1.5 rounded-full p-0" aria-hidden="true" />
    </Button>
  )
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
