"use client"

import { ArrowLeft, ArrowRight } from "lucide-react"

import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { Button } from "@/components/ui/button"

export function DesktopShellHeader() {
  return (
    <header className="aa-window-drag flex h-11 shrink-0 items-center border-b border-border/80 bg-background text-foreground">
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
      <div
        data-slot="desktop-shell-header-actions"
        className="ml-auto flex h-full min-w-0 flex-1 items-center justify-end px-3"
      />
    </header>
  )
}
