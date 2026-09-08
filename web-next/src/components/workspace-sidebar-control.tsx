"use client"

import * as React from "react"
import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"

import { WorkspaceSidebarControlContext } from "@/components/dashboard-sidebar-controls"

// The control belongs to the workspace, outside both the collapsible sidebar
// and the chat surface that becomes inert when a tool fills the main area.
export function WorkspaceSidebarControl({ children }: { children: React.ReactNode }) {
  return (
    <WorkspaceSidebarControlContext.Provider value>
      <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {children}
        <div className="absolute left-3 top-2.5 z-40">
          <DashboardSidebarToggle standalone />
        </div>
      </div>
    </WorkspaceSidebarControlContext.Provider>
  )
}
