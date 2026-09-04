"use client"

import * as React from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"

import { SidebarProvider, SidebarInset, useSidebar } from "@/components/ui/sidebar"
import { DashboardSidebarControlsContext } from "@/components/dashboard-sidebar-controls"
import { AppSidebar } from "@/components/app-sidebar"
import { DesktopShellHeader } from "@/components/desktop/desktop-shell-header"
import { DesktopSessionNotifications } from "@/components/desktop/desktop-session-notifications"
import { TaskComposer } from "@/components/task-composer"
import { SessionView } from "@/components/session-view"
import { SettingsPage } from "@/components/pages/settings-page"
import { DashboardPage } from "@/components/pages/dashboard-page"
import { TeamPage } from "@/components/pages/team-page"
import { ServicePage } from "@/components/pages/service-page"
import { DevicePage } from "@/components/pages/device-page"
import { DeviceWorkspacePage } from "@/components/pages/device-workspace-page"
import { MobileConnectionsPage } from "@/components/pages/mobile-connections-page"
import { WorkspaceProvider, useWorkspace } from "@/components/workspace-context"
import { LoadingState } from "@/components/loading-state"
import { PairDeviceDialog } from "@/components/pair-device-dialog"
import { useAuth } from "@/components/auth/auth-context"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { useTranslations } from "next-intl"
import { DesktopConnectorProvider } from "@/features/desktop/desktop-connector-context"

const SIDEBAR_LAYOUT_STORAGE_KEY = "agents-anywhere-dashboard-sidebar-layout"
const DEFAULT_DESKTOP_LAYOUT = {
  "dashboard-sidebar": 256,
  "dashboard-main": 1024,
}

export function Demo() {
  return (
    <WorkspaceProvider>
      <DesktopConnectorProvider>
        <DesktopSessionNotifications />
        <SidebarProvider>
          <DashboardShell />
        </SidebarProvider>
      </DesktopConnectorProvider>
    </WorkspaceProvider>
  )
}

function DashboardShell() {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <>
        <AppSidebar />
        <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-none bg-background">
          <WorkspaceMain />
        </SidebarInset>
      </>
    )
  }

  return <DesktopResizableShell />
}

function DesktopResizableShell() {
  const { open, setOpen } = useSidebar()
  const sidebarPanelRef = React.useRef<PanelImperativeHandle | null>(null)
  const [sidebarResizeActive, setSidebarResizeActive] = React.useState(false)
  const [defaultLayout] = React.useState(() => {
    if (typeof window === "undefined") return DEFAULT_DESKTOP_LAYOUT

    const stored = window.localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY)
    if (!stored) return DEFAULT_DESKTOP_LAYOUT

    try {
      const layout = JSON.parse(stored) as Record<string, number>
      return typeof layout["dashboard-sidebar"] === "number" && typeof layout["dashboard-main"] === "number"
        ? layout
        : DEFAULT_DESKTOP_LAYOUT
    } catch {
      return DEFAULT_DESKTOP_LAYOUT
    }
  })
  const [sidebarWidth, setSidebarWidth] = React.useState(
    defaultLayout["dashboard-sidebar"] ?? DEFAULT_DESKTOP_LAYOUT["dashboard-sidebar"]
  )

  React.useEffect(() => {
    const panel = sidebarPanelRef.current
    if (!panel) return

    if (open && panel.isCollapsed()) {
      panel.expand()
      return
    }

    if (!open && !panel.isCollapsed()) {
      panel.collapse()
    }
  }, [open])

  const collapseSidebar = React.useCallback(() => {
    const panel = sidebarPanelRef.current
    if (panel && !panel.isCollapsed()) {
      panel.collapse()
    }
    setOpen(false, { persist: false })
  }, [setOpen])

  const toggleSidebar = React.useCallback(() => {
    const panel = sidebarPanelRef.current
    if (open) {
      if (panel && !panel.isCollapsed()) {
        panel.collapse()
      }
      setOpen(false, { persist: false })
      return
    }

    if (panel?.isCollapsed()) {
      panel.expand()
    }
    setOpen(true, { persist: false })
  }, [open, setOpen])

  const sidebarControls = React.useMemo(
    () => ({ open, collapseSidebar, toggleSidebar }),
    [open, collapseSidebar, toggleSidebar]
  )
  const panelMotionClassName = sidebarResizeActive
    ? "[&>[data-panel]]:transition-none"
    : "[&>[data-panel]]:transition-[flex-grow] [&>[data-panel]]:duration-[220ms] [&>[data-panel]]:ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:[&>[data-panel]]:transition-none"

  return (
    <DashboardSidebarControlsContext.Provider value={sidebarControls}>
      <div className="flex h-svh min-h-0 w-full flex-col overflow-hidden overscroll-none bg-background">
        <DesktopShellHeader sidebarWidth={sidebarWidth} sidebarOpen={open} />
        <ResizablePanelGroup
          id="agents-anywhere-dashboard-sidebar"
          defaultLayout={defaultLayout}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction) {
              window.localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
            }
          }}
          direction="horizontal"
          className={`min-h-0 flex-1 overflow-hidden overscroll-none bg-background ${panelMotionClassName}`}
        >
          <ResizablePanel
            id="dashboard-sidebar"
            panelRef={sidebarPanelRef}
            collapsible
            collapsedSize={0}
            defaultSize="16rem"
            minSize="14rem"
            maxSize="28rem"
            onResize={(size) => {
              setSidebarWidth(size.inPixels)
              const isCollapsed = sidebarPanelRef.current?.isCollapsed() ?? size.inPixels <= 1
              const nextOpen = !isCollapsed
              if (nextOpen !== open) {
                setOpen(nextOpen, { persist: false })
              }
            }}
            className="min-w-0 overflow-hidden"
          >
            <AppSidebar contained />
          </ResizablePanel>
          <ResizableHandle
            className="bg-transparent transition-colors hover:bg-border/40 focus-visible:bg-border/60"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              setSidebarResizeActive(true)
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              setSidebarResizeActive(false)
            }}
            onPointerCancel={() => setSidebarResizeActive(false)}
            onLostPointerCapture={() => setSidebarResizeActive(false)}
          />
          <ResizablePanel id="dashboard-main" minSize={0} className="min-w-0">
            <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-none bg-background">
              <WorkspaceMain />
            </SidebarInset>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </DashboardSidebarControlsContext.Provider>
  )
}

function WorkspaceMain() {
  const { me } = useAuth()
  const {
    page,
    isLoading,
    routeReady,
    newSessionProjectId,
    firstDevicePromptOpen,
    pairDeviceDialogOpen,
    closeFirstDevicePrompt,
    openPairDeviceDialog,
    closePairDeviceDialog,
    refreshData,
  } = useWorkspace()
  const t = useTranslations("dashboard.firstDevice")
  const canRenderBeforeDataLoad = page === "home" && newSessionProjectId === null
  const isAdmin = me?.role === "admin"
  if (!routeReady || (!canRenderBeforeDataLoad && isLoading)) {
    return <LoadingState className="h-full bg-background" />
  }
  const effectivePage = !isAdmin && (page === "dashboard" || page === "team" || page === "service") ? "home" : page
  const content =
    effectivePage === "settings" ? <SettingsPage /> :
    effectivePage === "dashboard" ? <DashboardPage /> :
    effectivePage === "team" ? <TeamPage /> :
    effectivePage === "service" ? <ServicePage /> :
    effectivePage === "mobile-connections" ? <MobileConnectionsPage /> :
    effectivePage === "session" ? <SessionView /> :
    effectivePage === "device" ? <DevicePage /> :
    effectivePage === "device-workspace" ? <DeviceWorkspacePage /> :
    <TaskComposer />
  return (
    <>
      {content}
      <AlertDialog open={firstDevicePromptOpen} onOpenChange={(open: boolean) => {
        if (!open) closeFirstDevicePrompt()
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("later")}</AlertDialogCancel>
            <AlertDialogAction onClick={openPairDeviceDialog}>{t("addDevice")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PairDeviceDialog
        open={pairDeviceDialogOpen}
        onOpenChange={(open) => {
          if (!open) closePairDeviceDialog()
        }}
        onConnectorCreated={() => {
          closePairDeviceDialog()
          refreshData()
        }}
      />
    </>
  )
}
