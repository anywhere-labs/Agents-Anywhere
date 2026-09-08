"use client"

import * as React from "react"
import { WorkspaceSidebarControlContext } from "@/components/dashboard-sidebar-controls"
import { PanelLeft } from "lucide-react"
import { useTranslations } from "next-intl"

import { useDashboardSidebarControls } from "@/components/dashboard-sidebar-controls"
import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

export function DashboardSidebarToggle({ className, standalone = false }: { className?: string; standalone?: boolean }) {
  const managed = React.useContext(WorkspaceSidebarControlContext)
  const { isMobile, open, openMobile, toggleSidebar } = useSidebar()
  const sidebarControls = useDashboardSidebarControls()
  const tActions = useTranslations("dashboard.actions")

  const toggleDashboardSidebar = React.useCallback(() => {
    if (isMobile) {
      toggleSidebar()
      return
    }
    if (sidebarControls) sidebarControls.toggleSidebar()
    else toggleSidebar()
  }, [isMobile, sidebarControls, toggleSidebar])

  if (managed && !standalone) return <span aria-hidden="true" className={cn("size-9 shrink-0", className)} />

  return (
    <Button
      variant="ghost"
      size="icon-lg"
      type="button"
      aria-label={(isMobile ? openMobile : open) ? tActions("collapse") : tActions("expand")}
      aria-expanded={isMobile ? openMobile : open}
      data-slot="workspace-sidebar-toggle"
      onClick={toggleDashboardSidebar}
      className={cn("shrink-0 text-muted-foreground hover:text-foreground [&_svg:not([class*='size-'])]:size-5", className)}
    >
      <PanelLeft data-icon="inline-start" />
    </Button>
  )
}
