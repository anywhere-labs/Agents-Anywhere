"use client"

import * as React from "react"
import { ArrowLeft, ArrowRight, Eraser, Info } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useWorkspace } from "@/components/workspace-context"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import { useDesktopConnector } from "@/features/desktop/desktop-connector-context"

const HEADER_SIDEBAR_MIN_WIDTH = 224

export function DesktopShellHeader({
  sidebarOpen,
  sidebarResizing,
}: {
  sidebarOpen: boolean
  sidebarResizing: boolean
}) {
  const t = useTranslations("desktopConnector")
  const tCommon = useTranslations("common")
  const { canGoBack, canGoForward, goBack, goForward } = useWorkspace()
  const { supported, busy, state, binding, reconnect } = useDesktopConnector()
  const [canClearCache, setCanClearCache] = React.useState(false)
  const [clearingCache, setClearingCache] = React.useState(false)
  const localConnectorId = binding?.connectorId ?? state?.connectorId
  const needsReconnect = Boolean(
    supported &&
    localConnectorId &&
    (state?.authFailed || state?.manualDisconnected),
  )
  const headerSidebarWidth = sidebarOpen
    ? "var(--desktop-sidebar-width)"
    : HEADER_SIDEBAR_MIN_WIDTH
  const sidebarWidthMotionClassName = sidebarResizing
    ? "transition-none"
    : "transition-[width] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
  const shellControlClassName = sidebarOpen
    ? "rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    : "rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"

  React.useEffect(() => {
    if (process.env.NODE_ENV !== "development") return
    setCanClearCache(Boolean(getDesktopWorkbenchBridge()?.development?.clearCache))
  }, [])

  const clearCache = React.useCallback(async () => {
    const clear = getDesktopWorkbenchBridge()?.development?.clearCache
    if (!clear) return
    setClearingCache(true)
    try {
      await clear()
    } catch (error) {
      setClearingCache(false)
      toast.error(error instanceof Error ? error.message : t("clearCacheFailed"))
    }
  }, [t])

  return (
    <header className="aa-window-drag relative flex h-11 shrink-0 items-center bg-background text-foreground">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border/80"
      />
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-y-0 left-0 bg-sidebar ${sidebarWidthMotionClassName}`}
        style={{ width: sidebarOpen ? "var(--desktop-sidebar-width)" : 0 }}
      />
      <div
        className={sidebarOpen
          ? `relative flex h-full shrink-0 items-center text-sidebar-foreground ${sidebarWidthMotionClassName}`
          : `relative flex h-full shrink-0 items-center text-foreground ${sidebarWidthMotionClassName}`
        }
        style={{ width: headerSidebarWidth }}
      >
        <div className="w-[6.5rem] shrink-0" aria-hidden="true" />
        <div className="aa-window-no-drag flex min-w-0 items-center gap-2">
          <DashboardSidebarToggle
            showOnDesktop
            className={shellControlClassName}
          />
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={tCommon("back")}
              title={tCommon("back")}
              onClick={goBack}
              disabled={!canGoBack}
              className={shellControlClassName}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={tCommon("forward")}
              title={tCommon("forward")}
              onClick={goForward}
              disabled={!canGoForward}
              className={shellControlClassName}
            >
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>
      <div
        data-slot="desktop-shell-header-session"
        className="aa-window-no-drag ml-2 flex min-w-0 flex-1 items-center overflow-hidden"
      />
      {needsReconnect ? (
        <div className="aa-window-no-drag absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-white" role="status" aria-live="polite">
            <Info className="size-3.5 text-destructive" aria-hidden="true" />
            {t("localOffline")}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void reconnect()}
            disabled={busy}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy ? t("reconnecting") : t("reconnect")}
          </Button>
        </div>
      ) : null}
      <div
        data-slot="desktop-shell-header-actions"
        className="ml-auto flex h-full shrink-0 items-center justify-end gap-1 px-3"
      >
        {canClearCache ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void clearCache()}
            disabled={clearingCache}
            aria-label={t("clearCache")}
            title={t("clearCache")}
            className="aa-window-no-drag rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {clearingCache ? <Spinner data-icon="inline-start" /> : <Eraser data-icon="inline-start" />}
            {clearingCache ? t("clearingCache") : t("clearCache")}
          </Button>
        ) : null}
        <div
          data-slot="desktop-shell-header-session-actions"
          className="aa-window-no-drag flex shrink-0 items-center"
        />
      </div>
      {!sidebarOpen ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 h-5 w-px -translate-y-1/2 bg-border/60"
          style={{ left: headerSidebarWidth }}
        />
      ) : null}
    </header>
  )
}
