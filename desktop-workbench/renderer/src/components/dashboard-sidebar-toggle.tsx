"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

import { useDashboardSidebarControls } from "@/components/dashboard-sidebar-controls"
import { WorkspaceSidebarToggleButton } from "@/components/workspace-sidebar-toggle-button"
import { useSidebar } from "@/components/ui/sidebar"

export function DashboardSidebarToggle({
  className,
  showOnDesktop = false,
}: {
  className?: string
  showOnDesktop?: boolean
}) {
  const { isMobile, open, openMobile, toggleSidebar } = useSidebar()
  const sidebarControls = useDashboardSidebarControls()
  const tActions = useTranslations("dashboard.actions")
  const isExpanded = isMobile ? openMobile : sidebarControls?.open ?? open

  const toggleDashboardSidebar = React.useCallback(() => {
    if (isMobile) {
      toggleSidebar()
      return
    }
    sidebarControls?.toggleSidebar()
  }, [isMobile, sidebarControls, toggleSidebar])

  if (!isMobile && !showOnDesktop) return null

  return (
    <WorkspaceSidebarToggleButton
      side="left"
      aria-label={isExpanded ? tActions("collapse") : tActions("expand")}
      aria-expanded={isExpanded}
      data-slot="workspace-sidebar-toggle"
      onClick={toggleDashboardSidebar}
      className={className}
    />
  )
}
