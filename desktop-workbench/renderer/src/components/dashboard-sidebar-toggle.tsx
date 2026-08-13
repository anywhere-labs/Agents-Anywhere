"use client"

import * as React from "react"
import { PanelLeft } from "lucide-react"
import { useTranslations } from "next-intl"

import { useDashboardSidebarControls } from "@/components/dashboard-sidebar-controls"
import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

export function DashboardSidebarToggle({ className }: { className?: string }) {
  const { isMobile, toggleSidebar } = useSidebar()
  const sidebarControls = useDashboardSidebarControls()
  const tActions = useTranslations("dashboard.actions")

  const toggleDashboardSidebar = React.useCallback(() => {
    if (isMobile) {
      toggleSidebar()
      return
    }
    sidebarControls?.toggleSidebar()
  }, [isMobile, sidebarControls, toggleSidebar])

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label={sidebarControls?.open === false ? tActions("expand") : tActions("collapse")}
      onClick={toggleDashboardSidebar}
      className={cn("shrink-0 text-muted-foreground hover:text-foreground", className)}
    >
      <PanelLeft className="size-4" />
    </Button>
  )
}
