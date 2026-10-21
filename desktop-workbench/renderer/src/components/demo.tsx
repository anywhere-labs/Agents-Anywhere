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
import { WorkspaceHeaderBackdrop } from "@/components/workspace-header"
import { SessionToolSidebarsHost } from "@/components/session-tool-sidebar"
import { SettingsPage } from "@/components/pages/settings-page"
import { SettingsSidebar } from "@/components/settings/settings-sidebar"
import { SidebarSwitch } from "@/components/sidebar-switch"
import { AdminPage } from "@/components/admin/admin-page"
import { AdminSidebar } from "@/components/admin/admin-sidebar"
import { DevicePage } from "@/components/pages/device-page"
import { MobileConnectionsPage } from "@/components/pages/mobile-connections-page"
import { WorkspaceProvider, useWorkspace } from "@/components/workspace-context"
import { LoadingState } from "@/components/loading-state"
import { PairDeviceDialog } from "@/components/pair-device-dialog"
import { DevicePairingProvider } from "@/components/device-pairing-provider"
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
const DESKTOP_SIDEBAR_MIN_WIDTH = 224
const SIDEBAR_MOTION_DURATION_MS = 220

export function Demo() {
  return (
    <WorkspaceProvider>
      <DevicePairingProvider>
        <DesktopConnectorProvider>
          <DesktopSessionNotifications />
          <SidebarProvider>
            <DashboardShell />
          </SidebarProvider>
        </DesktopConnectorProvider>
      </DevicePairingProvider>
    </WorkspaceProvider>
  )
}

/** The sidebar slot: workspace by default, section navigation on standalone pages. */
type SidebarKind = "home" | "admin" | "settings"

// Administration and settings sit one level below the session list, so moving
// into them pushes their sidebar in and returning home pops it off again.
const SIDEBAR_DEPTH: Record<SidebarKind, number> = { home: 0, admin: 1, settings: 1 }

function renderSidebar(kind: string, contained: boolean) {
  if (kind === "admin") return <AdminSidebar contained={contained} />
  if (kind === "settings") return <SettingsSidebar contained={contained} />
  return <AppSidebar contained={contained} />
}

function WorkspaceNavigation({ contained = false }: { contained?: boolean }) {
  const { page } = useWorkspace()
  const { me } = useAuth()
  const kind: SidebarKind =
    page === "admin" && me?.role === "admin" ? "admin" : page === "settings" ? "settings" : "home"
  // The mobile sidebar is a sheet that closes on navigation; only the docked
  // sidebar switches in place.
  if (!contained) return renderSidebar(kind, false)
  return (
    <SidebarSwitch id={kind} depth={SIDEBAR_DEPTH[kind]}>
      {(layer) => renderSidebar(layer, true)}
    </SidebarSwitch>
  )
}

function DashboardShell() {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <>
        <WorkspaceNavigation />
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
  const { page } = useWorkspace()
  const desktopShellRef = React.useRef<HTMLDivElement | null>(null)
  const sidebarPanelRef = React.useRef<PanelImperativeHandle | null>(null)
  const sidebarMotionActiveRef = React.useRef(false)
  const sidebarMotionTimerRef = React.useRef<number | null>(null)
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

  const beginSidebarMotion = React.useCallback(() => {
    sidebarMotionActiveRef.current = true
    if (sidebarMotionTimerRef.current !== null) {
      window.clearTimeout(sidebarMotionTimerRef.current)
    }
    sidebarMotionTimerRef.current = window.setTimeout(() => {
      sidebarMotionActiveRef.current = false
      sidebarMotionTimerRef.current = null
      const panel = sidebarPanelRef.current
      if (panel && !panel.isCollapsed()) {
        setSidebarWidth(panel.getSize().inPixels)
      }
    }, SIDEBAR_MOTION_DURATION_MS + 40)
  }, [])

  React.useEffect(() => () => {
    if (sidebarMotionTimerRef.current !== null) {
      window.clearTimeout(sidebarMotionTimerRef.current)
    }
  }, [])

  React.useEffect(() => {
    const panel = sidebarPanelRef.current
    if (!panel) return

    if (open && panel.isCollapsed()) {
      beginSidebarMotion()
      panel.expand()
      return
    }

    if (!open && !panel.isCollapsed()) {
      beginSidebarMotion()
      panel.collapse()
    }
  }, [beginSidebarMotion, open])

  const collapseSidebar = React.useCallback(() => {
    const panel = sidebarPanelRef.current
    if (panel && !panel.isCollapsed()) {
      beginSidebarMotion()
      panel.collapse()
    }
    setOpen(false, { persist: false })
  }, [beginSidebarMotion, setOpen])

  const toggleSidebar = React.useCallback(() => {
    const panel = sidebarPanelRef.current
    if (open) {
      if (panel && !panel.isCollapsed()) {
        beginSidebarMotion()
        panel.collapse()
      }
      setOpen(false, { persist: false })
      return
    }

    if (panel?.isCollapsed()) {
      beginSidebarMotion()
      panel.expand()
    }
    setOpen(true, { persist: false })
  }, [beginSidebarMotion, open, setOpen])

  const sidebarControls = React.useMemo(
    () => ({ open, collapseSidebar, toggleSidebar }),
    [open, collapseSidebar, toggleSidebar]
  )
  const panelMotionClassName = sidebarResizeActive
    ? "[&>[data-panel]]:transition-none"
    : "[&>[data-panel]]:transition-[flex-grow] [&>[data-panel]]:duration-[220ms] [&>[data-panel]]:ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:[&>[data-panel]]:transition-none"
  const shellHeader = (
    <DesktopShellHeader
      key="desktop-shell-header"
      sidebarOpen={open}
      sidebarResizing={sidebarResizeActive}
    />
  )

  return (
    <DashboardSidebarControlsContext.Provider value={sidebarControls}>
      <div
        ref={desktopShellRef}
        data-sidebar-open={open}
        className="aa-desktop-shell relative flex h-svh min-h-0 w-full flex-col overflow-hidden overscroll-none"
        style={{
          "--desktop-sidebar-width": `${Math.max(sidebarWidth, DESKTOP_SIDEBAR_MIN_WIDTH)}px`,
        } as React.CSSProperties}
      >
        <ResizablePanelGroup
          id="agents-anywhere-dashboard-sidebar"
          defaultLayout={defaultLayout}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction) {
              window.localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
            }
          }}
          direction="horizontal"
          className={`min-h-0 flex-1 overflow-hidden overscroll-none ${panelMotionClassName}`}
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
              const isCollapsed = sidebarPanelRef.current?.isCollapsed() ?? size.inPixels <= 1
              if (!sidebarMotionActiveRef.current && !isCollapsed) {
                desktopShellRef.current?.style.setProperty(
                  "--desktop-sidebar-width",
                  `${Math.max(size.inPixels, DESKTOP_SIDEBAR_MIN_WIDTH)}px`,
                )
                setSidebarWidth(size.inPixels)
              }
              const nextOpen = !isCollapsed
              if (nextOpen !== open) {
                setOpen(nextOpen, { persist: false })
              }
            }}
            className="min-w-0"
            style={{ overflow: "hidden" }}
          >
            <div
              className="aa-desktop-sidebar h-full shrink-0 overflow-hidden"
              style={{ width: Math.max(sidebarWidth, DESKTOP_SIDEBAR_MIN_WIDTH) }}
            >
              <WorkspaceNavigation contained />
            </div>
          </ResizablePanel>
          <ResizableHandle
            showSeparator={false}
            className="w-0 bg-transparent focus-visible:after:bg-ring/30"
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
            <SidebarInset data-page={page} className="aa-desktop-main h-full min-h-0 overflow-hidden overscroll-none bg-background">
              <div className="aa-desktop-drag-region" aria-hidden="true" />
              {page === "session" ? (
                // Overlays the timeline like the web session header so content scrolls under the blur.
                <>
                  <header className="pointer-events-none absolute inset-x-0 top-0 z-10 h-14 overflow-hidden">
                    <WorkspaceHeaderBackdrop />
                    <div className="aa-desktop-session-header aa-window-drag pointer-events-auto relative flex h-11 items-center gap-2 px-3">
                      <div data-slot="desktop-shell-header-session" className="flex min-w-0 flex-1 items-center overflow-hidden" />
                      <div className="size-8 shrink-0" aria-hidden="true" />
                    </div>
                  </header>
                  {/* Outside the header's stacking context so the tool sidebar toggle stays above the open tool sidebar. */}
                  <div data-slot="desktop-shell-header-session-actions" className="aa-window-no-drag absolute right-3 top-0 z-50 flex h-11 items-center" />
                </>
              ) : null}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <WorkspaceMain />
              </div>
            </SidebarInset>
          </ResizablePanel>
        </ResizablePanelGroup>
        {shellHeader}
      </div>
      <SessionToolSidebarsHost />
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
    replaceHome,
  } = useWorkspace()
  const t = useTranslations("dashboard.firstDevice")
  const isAdmin = me?.role === "admin"
  // Members who land on an administration route go home instead of seeing
  // an empty admin shell; the hash is replaced so Back does not loop.
  React.useEffect(() => {
    if (routeReady && page === "admin" && me && !isAdmin) replaceHome()
  }, [isAdmin, me, page, replaceHome, routeReady])
  // Administration and personal settings render without the workspace inventory.
  const canRenderBeforeDataLoad =
    (page === "home" && newSessionProjectId === null) || page === "admin" || page === "settings"
  if (!routeReady || (page === "admin" && !isAdmin) || (!canRenderBeforeDataLoad && isLoading)) {
    return <LoadingState className="h-full bg-background" />
  }
  const content =
    page === "settings" ? <SettingsPage /> :
    page === "admin" ? <AdminPage /> :
    page === "mobile-connections" ? <MobileConnectionsPage /> :
    page === "session" ? <SessionView /> :
    page === "device" ? <DevicePage /> :
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
          refreshData()
        }}
      />
    </>
  )
}
