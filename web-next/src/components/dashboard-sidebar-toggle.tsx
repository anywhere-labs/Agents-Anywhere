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

  const expanded = isMobile ? openMobile : open

  if (managed && !standalone) return <span aria-hidden="true" className={cn("size-7 shrink-0", className)} />

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label={expanded ? tActions("collapse") : tActions("expand")}
      aria-expanded={expanded}
      data-slot="workspace-sidebar-toggle"
      onClick={toggleDashboardSidebar}
      // Match the right-sidebar collapse control: icon only, background on hover.
      // The ghost variant paints a permanent muted background while aria-expanded is
      // true, so opt out of that state style and keep the hover feedback instead.
      className={cn(
        "shrink-0 text-muted-foreground hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:aria-expanded:bg-muted hover:aria-expanded:text-foreground",
        className,
      )}
    >
      <PanelLeft />
    </Button>
  )
}
