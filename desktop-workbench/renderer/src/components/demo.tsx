"use client"

import * as React from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { ArrowLeft, ArrowRight } from "lucide-react"

import { SidebarProvider, SidebarInset, useSidebar } from "@/components/ui/sidebar"
import { DashboardSidebarControlsContext } from "@/components/dashboard-sidebar-controls"
import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { AppSidebar } from "@/components/app-sidebar"
import { Button } from "@/components/ui/button"
import { TaskComposer } from "@/components/task-composer"
import { SessionView } from "@/components/session-view"
import { SettingsPage } from "@/components/pages/settings-page"
import { DashboardPage } from "@/components/pages/dashboard-page"
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

  return (
    <DashboardSidebarControlsContext.Provider value={sidebarControls}>
      <div className="flex h-svh min-h-0 w-full flex-col overflow-hidden overscroll-none bg-background">
        <DesktopShellHeader />
        <ResizablePanelGroup
          id="agents-anywhere-dashboard-sidebar"
          defaultLayout={defaultLayout}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction) {
              window.localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
            }
          }}
          direction="horizontal"
          className="min-h-0 flex-1 overflow-hidden overscroll-none bg-background"
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
                setOpen(nextOpen, { persist: false })
              }
            }}
            className="min-w-0"
          >
            <AppSidebar contained />
          </ResizablePanel>
          <ResizableHandle className="bg-transparent transition-colors hover:bg-border/40 focus-visible:bg-border/60" />
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

function DesktopShellHeader() {
  return (
    <header className="aa-window-drag flex h-12 shrink-0 items-center border-b border-border/80 bg-background text-foreground">
      <div className="w-[6.5rem] shrink-0" aria-hidden="true" />
      <div className="aa-window-no-drag flex min-w-0 items-center gap-2">
        <DashboardSidebarToggle showOnDesktop className="rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" />
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            aria-disabled="true"
            tabIndex={-1}
            className="rounded-md text-muted-foreground/65 hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Forward"
            aria-disabled="true"
            tabIndex={-1}
            className="rounded-md text-muted-foreground/40 hover:bg-muted hover:text-foreground"
          >
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
      <div data-slot="desktop-shell-header-actions" className="aa-window-no-drag ml-auto flex h-full min-w-0 flex-1 items-center justify-end px-3" />
    </header>
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
  const effectivePage = !isAdmin && (page === "dashboard" || page === "team" || page === "service") ? "home" : page
  const content =
    effectivePage === "settings" ? <SettingsPage /> :
    effectivePage === "dashboard" ? <DashboardPage /> :
    effectivePage === "team" ? <TeamPage /> :
    effectivePage === "service" ? <ServicePage /> :
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
