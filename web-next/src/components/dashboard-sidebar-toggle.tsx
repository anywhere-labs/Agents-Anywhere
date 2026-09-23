"use client"

import * as React from "react"
import { WorkspaceSidebarControlContext } from "@/components/dashboard-sidebar-controls"
import { useTranslations } from "next-intl"

import { useDashboardSidebarControls } from "@/components/dashboard-sidebar-controls"
import { WorkspaceSidebarToggleButton } from "@/components/workspace-sidebar-toggle-button"
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

  const expanded = isMobile ? openMobile : open

  if (managed && !standalone) return <span aria-hidden="true" className={cn("size-7 shrink-0", className)} />

  return (
    <WorkspaceSidebarToggleButton
      side="left"
      aria-label={expanded ? tActions("collapse") : tActions("expand")}
      aria-expanded={expanded}
      data-slot="workspace-sidebar-toggle"
      onClick={toggleDashboardSidebar}
      className={className}
    />
  )
}
