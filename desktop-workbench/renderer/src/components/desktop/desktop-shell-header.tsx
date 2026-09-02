"use client"

import { ArrowLeft, ArrowRight, Info } from "lucide-react"
import { useTranslations } from "next-intl"

import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useDesktopConnector } from "@/features/desktop/desktop-connector-context"

export function DesktopShellHeader() {
  const t = useTranslations("desktopConnector")
  const { supported, busy, state, binding, reconnect } = useDesktopConnector()
  const localConnectorId = binding?.connectorId ?? state?.connectorId
  const needsReconnect = Boolean(
    supported &&
    localConnectorId &&
    (state?.authFailed || state?.manualDisconnected),
  )

  return (
    <header className="aa-window-drag relative flex h-11 shrink-0 items-center border-b border-border/80 bg-background text-foreground">
      <div className="w-[6.5rem] shrink-0" aria-hidden="true" />
      <div className="aa-window-no-drag flex min-w-0 items-center gap-2">
        <DashboardSidebarToggle
          showOnDesktop
          className="rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        />
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            aria-disabled="true"
            tabIndex={-1}
            className="rounded-md text-muted-foreground/65 hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Forward"
            aria-disabled="true"
            tabIndex={-1}
            className="rounded-md text-muted-foreground/40 hover:bg-muted hover:text-foreground"
          >
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
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
        className="ml-auto flex h-full min-w-0 flex-1 items-center justify-end px-3"
      />
    </header>
  )
}
