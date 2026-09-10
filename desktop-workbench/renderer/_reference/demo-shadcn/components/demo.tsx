"use client"

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { TaskComposer } from "@/components/task-composer"
import { SessionView } from "@/components/session-view"
import { SettingsPage } from "@/components/pages/settings-page"
import { TeamPage } from "@/components/pages/team-page"
import { ServicePage } from "@/components/pages/service-page"
import { DevicePage } from "@/components/pages/device-page"
import { DeviceWorkspacePage } from "@/components/pages/device-workspace-page"
import { WorkspaceProvider, useWorkspace } from "@/components/workspace-context"

export function Demo() {
  return (
    <WorkspaceProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="bg-background">
          <WorkspaceMain />
        </SidebarInset>
      </SidebarProvider>
    </WorkspaceProvider>
  )
}

function WorkspaceMain() {
  const { page } = useWorkspace()
  if (page === "settings") return <SettingsPage />
  if (page === "team") return <TeamPage />
  if (page === "service") return <ServicePage />
  if (page === "session") return <SessionView />
  if (page === "device") return <DevicePage />
  if (page === "device-workspace") return <DeviceWorkspacePage />
  return <TaskComposer />
}
