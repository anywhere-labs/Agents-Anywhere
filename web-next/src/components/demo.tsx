"use client"

import * as React from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"

import { SidebarProvider, SidebarInset, useSidebar } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { TaskComposer } from "@/components/task-composer"
import { SessionView } from "@/components/session-view"
import { SettingsPage } from "@/components/pages/settings-page"
import { TeamPage } from "@/components/pages/team-page"
import { ServicePage } from "@/components/pages/service-page"
import { DevicePage } from "@/components/pages/device-page"
import { DeviceWorkspacePage } from "@/components/pages/device-workspace-page"
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

const SIDEBAR_LAYOUT_STORAGE_KEY = "agents-anywhere-dashboard-sidebar-layout"
const DEFAULT_DESKTOP_LAYOUT = {
  "dashboard-sidebar": 256,
  "dashboard-main": 1024,
}

type DashboardSidebarControls = {
  collapseSidebar: () => void
}

const DashboardSidebarControlsContext = React.createContext<DashboardSidebarControls | null>(null)

export function useDashboardSidebarControls() {
  return React.useContext(DashboardSidebarControlsContext)
}

export function Demo() {
  return (
    <WorkspaceProvider>
      <SidebarProvider>
        <DashboardShell />
      </SidebarProvider>
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
    setOpen(false)
    panel?.collapse()
  }, [setOpen])

  const sidebarControls = React.useMemo(() => ({ collapseSidebar }), [collapseSidebar])

  return (
    <DashboardSidebarControlsContext.Provider value={sidebarControls}>
      <ResizablePanelGroup
        id="agents-anywhere-dashboard-sidebar"
        defaultLayout={defaultLayout}
        onLayoutChanged={(layout) => {
          window.localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
        }}
        direction="horizontal"
        className="h-svh min-h-0 w-full overflow-hidden overscroll-none bg-background"
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
            const nextOpen = size.inPixels > 1
            if (nextOpen !== open) {
              setOpen(nextOpen)
            }
          }}
          className="min-w-0"
        >
          <AppSidebar contained />
        </ResizablePanel>
        <ResizableHandle className="bg-transparent transition-colors hover:bg-border/40 focus-visible:bg-border/60" />
        <ResizablePanel id="dashboard-main" minSize={0} className="min-w-0">
          <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-none bg-background">
            <WorkspaceMain />
          </SidebarInset>
        </ResizablePanel>
      </ResizablePanelGroup>
    </DashboardSidebarControlsContext.Provider>
  )
}

function WorkspaceMain() {
  const { me } = useAuth()
  const {
    page,
    isLoading,
    routeReady,
    firstDevicePromptOpen,
    pairDeviceDialogOpen,
    closeFirstDevicePrompt,
    openPairDeviceDialog,
    closePairDeviceDialog,
    refreshData,
  } = useWorkspace()
  const t = useTranslations("dashboard.firstDevice")
  const isNewSession = page === "home"
  const isAdmin = me?.role === "admin"
  if (!routeReady || (!isNewSession && isLoading)) {
    return <LoadingState className="h-full bg-background" />
  }
  const effectivePage = !isAdmin && (page === "team" || page === "service") ? "home" : page
  const content =
    effectivePage === "settings" ? <SettingsPage /> :
    effectivePage === "team" ? <TeamPage /> :
    effectivePage === "service" ? <ServicePage /> :
    effectivePage === "session" ? <SessionView /> :
    effectivePage === "device" ? <DevicePage /> :
    effectivePage === "device-workspace" ? <DeviceWorkspacePage /> :
    <TaskComposer />
  return (
    <>
      {content}
      <AlertDialog open={firstDevicePromptOpen} onOpenChange={(open) => {
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
