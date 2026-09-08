"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { ArrowLeft, ArrowRight, Info } from "lucide-react"
import { useTranslations } from "next-intl"

import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { WindowsTitleBarControlsContext } from "@/components/desktop/windows-title-bar"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useWorkspace } from "@/components/workspace-context"
import { useDesktopConnector } from "@/features/desktop/desktop-connector-context"
import { cn } from "@/lib/utils"

const HEADER_SIDEBAR_MIN_WIDTH = 224

export function DesktopShellHeader({
  sidebarOpen,
  sidebarResizing,
}: {
  sidebarOpen: boolean
  sidebarResizing: boolean
}) {
  const tCommon = useTranslations("common")
  const { canGoBack, canGoForward, goBack, goForward } = useWorkspace()
  const titleBarControls = React.useContext(WindowsTitleBarControlsContext)
  const shellControlClassName = "rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"

  const navigationControls = (
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
  )

  if (titleBarControls) return createPortal(navigationControls, titleBarControls)

  return (
    <header
      data-slot="desktop-shell-header"
      className={cn(
        "aa-desktop-navigation aa-window-drag absolute left-0 top-0 flex h-11 items-center text-sidebar-foreground",
        sidebarResizing ? "transition-none" : "transition-[width] duration-[220ms] motion-reduce:transition-none",
      )}
      style={{ width: sidebarOpen ? "var(--desktop-sidebar-width)" : HEADER_SIDEBAR_MIN_WIDTH }}
    >
      <div className="aa-traffic-light-spacer w-[6.5rem] shrink-0" aria-hidden="true" />
      {navigationControls}
    </header>
  )
}

export function DesktopConnectionStatus() {
  const t = useTranslations("desktopConnector")
  const { supported, busy, state, binding, reconnect } = useDesktopConnector()
  const localConnectorId = binding?.connectorId ?? state?.connectorId
  if (!supported || !localConnectorId || !(state?.authFailed || state?.manualDisconnected)) return null

  return (
    <div className="aa-window-no-drag flex flex-wrap items-center gap-2 px-1 pt-2">
      <span className="flex items-center gap-1.5 text-xs" role="status" aria-live="polite">
        <Info className="size-3.5 text-destructive" aria-hidden="true" />
        {t("localOffline")}
      </span>
      <Button type="button" variant="outline" size="xs" onClick={() => void reconnect()} disabled={busy}>
        {busy ? <Spinner data-icon="inline-start" /> : null}
        {busy ? t("reconnecting") : t("reconnect")}
      </Button>
    </div>
  )
}
