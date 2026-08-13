"use client"

import * as React from "react"

export type DashboardSidebarControls = {
  open: boolean
  collapseSidebar: () => void
  toggleSidebar: () => void
}

export const DashboardSidebarControlsContext = React.createContext<DashboardSidebarControls | null>(null)

export function useDashboardSidebarControls() {
  return React.useContext(DashboardSidebarControlsContext)
}
