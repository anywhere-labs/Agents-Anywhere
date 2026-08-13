"use client"

import * as React from "react"
import { PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { useTranslations } from "next-intl"

import { useDashboardSidebarControls } from "@/components/dashboard-sidebar-controls"
import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

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
  const Icon = isExpanded ? PanelLeftClose : PanelLeftOpen

  const toggleDashboardSidebar = React.useCallback(() => {
    if (isMobile) {
      toggleSidebar()
      return
    }
    sidebarControls?.toggleSidebar()
  }, [isMobile, sidebarControls, toggleSidebar])

  if (!isMobile && !showOnDesktop) return null

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label={isExpanded ? tActions("collapse") : tActions("expand")}
      onClick={toggleDashboardSidebar}
      className={cn("shrink-0 text-muted-foreground hover:text-foreground", className)}
    >
      <Icon data-icon="inline-start" />
    </Button>
  )
}
