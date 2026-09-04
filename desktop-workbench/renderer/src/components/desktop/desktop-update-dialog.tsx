"use client"

import { AlertTriangle, Download, PackageCheck } from "lucide-react"
import { useTranslations } from "next-intl"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import type { DesktopUpdateErrorCode, DesktopUpdateSnapshot } from "@/features/desktop/bridge"

type DesktopUpdateDialogProps = {
  state: DesktopUpdateSnapshot
  deferredOpen: boolean
  onDeferredOpenChange: (open: boolean) => void
  onCheck: () => Promise<void>
  onInstall: () => Promise<void>
  onDefer: () => Promise<void>
}

const ERROR_KEYS: Record<DesktopUpdateErrorCode, string> = {
  "required-update-unavailable": "requiredUnavailable",
  "check-failed": "checkFailed",
  "invalid-download": "invalidDownload",
  "download-failed": "downloadFailed",
  "open-failed": "openFailed",
}

export function DesktopUpdateDialog({
  state,
  deferredOpen,
  onDeferredOpenChange,
  onCheck,
  onInstall,
  onDefer,
}: DesktopUpdateDialogProps) {
  const t = useTranslations("desktopUpdate")
  const busy = state.phase === "checking-update" ||
    state.phase === "downloading" ||
    state.phase === "opening-installer"
  const open = state.forced ||
    state.phase === "available" ||
    state.phase === "downloading" ||
    state.phase === "opening-installer" ||
    (state.phase === "deferred" && deferredOpen)
  const canDismissDeferred = !state.forced && state.phase === "deferred" && !busy
  const installButtonText = state.phase === "checking-update"
    ? t("checking")
    : state.phase === "installer-opened"
      ? t("reopenInstaller")
      : state.errorCode
        ? t("retry")
        : state.forced && !state.release
          ? t("checkUpdate")
          : t("updateNow")

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen || state.forced || busy) return
    if (state.phase === "deferred") {
      onDeferredOpenChange(false)
      return
    }
    void onDefer()
  }

  const title = state.forced
    ? state.phase === "installer-opened"
      ? t("installerOpenedTitle")
      : t("requiredTitle")
    : t("availableTitle")
  const description = state.forced
    ? state.phase === "installer-opened"
      ? t("installerOpenedDescription")
      : t("requiredDescription")
    : t("availableDescription", { version: state.release?.versionName ?? "" })

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (!canDismissDeferred) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (!canDismissDeferred) event.preventDefault()
        }}
      >
        <DialogHeader className="gap-3">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground">
            {state.phase === "installer-opened" ? (
              <PackageCheck className="size-5" />
            ) : state.forced ? (
              <AlertTriangle className="size-5" />
            ) : (
              <Download className="size-5" />
            )}
          </div>
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <VersionSummary state={state} />

        {state.errorCode ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{t("errorTitle")}</AlertTitle>
            <AlertDescription>{t(`errors.${ERROR_KEYS[state.errorCode]}`)}</AlertDescription>
          </Alert>
        ) : null}

        {state.phase === "downloading" ? <DownloadProgress state={state} /> : null}

        {state.phase === "opening-installer" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            <span>{t("openingInstaller")}</span>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          {!state.forced && state.phase === "available" ? (
            <Button type="button" variant="outline" onClick={() => void onDefer()}>
              {t("later")}
            </Button>
          ) : !state.forced && state.phase === "deferred" ? (
            <Button type="button" variant="outline" onClick={() => onDeferredOpenChange(false)}>
              {t("close")}
            </Button>
          ) : null}
          {showInstallButton(state) ? (
            <Button
              type="button"
              onClick={() => void (state.forced && !state.release ? onCheck() : onInstall())}
              disabled={busy}
            >
              {busy ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />}
              {installButtonText}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function VersionSummary({ state }: { state: DesktopUpdateSnapshot }) {
  const t = useTranslations("desktopUpdate")
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{t("currentVersion")}</span>
      <Badge variant="outline">v{state.currentVersion}</Badge>
      {state.forced && state.serverVersion ? (
        <>
          <span className="text-muted-foreground">{t("serverVersion")}</span>
          <Badge variant="secondary">v{state.serverVersion}</Badge>
        </>
      ) : state.release ? (
        <>
          <span className="text-muted-foreground">{t("latestVersion")}</span>
          <Badge variant="secondary">v{state.release.versionName}</Badge>
        </>
      ) : null}
    </div>
  )
}

function DownloadProgress({ state }: { state: DesktopUpdateSnapshot }) {
  const t = useTranslations("desktopUpdate")
  const progress = state.progress
  const percent = progress?.percent
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">{t("downloading")}</span>
        <span className="text-muted-foreground tabular-nums">
          {percent == null ? formatBytes(progress?.receivedBytes ?? 0) : `${percent}%`}
        </span>
      </div>
      <Progress value={percent ?? 0} />
      <span className="text-xs text-muted-foreground">
        {progress?.totalBytes
          ? t("downloadedBytes", {
              received: formatBytes(progress.receivedBytes),
              total: formatBytes(progress.totalBytes),
            })
          : t("downloadSizeUnknown")}
      </span>
    </div>
  )
}

function showInstallButton(state: DesktopUpdateSnapshot): boolean {
  if (state.phase === "downloading" || state.phase === "opening-installer") return false
  return state.forced || state.phase === "available" || state.phase === "deferred"
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / 1024 ** exponent
  return `${amount >= 10 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`
}
