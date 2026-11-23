"use client"

// The workbench frame, mounted once for every workbench page (app/(workbench)/layout.tsx): the sidebar on the left
// (folds away with ⌘B or its header button, resized by dragging its edge; both remembered in this browser), the page,
// and Orches docked on the right (⌘J or its sidebar row; Effi's assistant dock). Phones get the sidebar as a drawer
// and Orches as a bottom sheet. Also the workbench-wide dialogs: search, shortcuts, settings, device pairing.
import { usePathname, useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { SearchIcon } from "lucide-react"

import { CollapsedNavBar } from "@/components/console/collapsed-nav-bar"
import { PageTransition } from "@/components/console/page-transition"
import { useRevealInTransition } from "@/components/console/use-reveal-in-transition"
import { useI18n } from "@/components/i18n-provider"
import { FullPageSpinner } from "@/components/spinner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AssistantPanel } from "@/components/workbench/assistant-panel"
import { Dock } from "@/components/workbench/dock"
import { PairDeviceDialog } from "@/components/workbench/pair-device-dialog"
import { RegisterDeviceDialog } from "@/components/workbench/register-device-dialog"
import { WorkbenchSidebar } from "@/components/workbench/workbench-sidebar"
import { WorkbenchUiContext, type WorkbenchUi } from "@/components/workbench/workbench-ui"
import { CommandPalette } from "@/components/workbench/command-palette"
import { ShortcutsDialog } from "@/components/workbench/shortcuts-dialog"
import { SettingsDialog, settingsSectionFrom, type SettingsSection } from "@/components/workbench/settings-dialog"
import { OrchesIcon } from "@/components/workbench/orches-icon"
import { SidebarReopen } from "@/components/workbench/sidebar-reopen"
import { useMediaQuery } from "@/hooks/use-media-query"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePanelWidth, type PanelWidthSpec } from "@/hooks/use-panel-width"
import { useViewportWidth } from "@/hooks/use-viewport-width"
import { useAssistant } from "@/lib/state/assistant-context"
import { useWorkbench } from "@/lib/state/workbench-context"

const SIDEBAR_WIDTH: PanelWidthSpec = {
  key: "aa.sidebar.width",
  initial: 256,
  min: 208,
  max: () => Math.max(208, Math.min(420, Math.round(window.innerWidth * 0.32))),
}
const SIDEBAR_OPEN_KEY = "aa.sidebar.open"

const ORCHES_WIDTH: PanelWidthSpec = {
  key: "aa.orches.width",
  initial: 400,
  min: 320,
  max: () => Math.max(320, Math.min(720, Math.round(window.innerWidth * 0.45))),
}

function storedSidebarOpen() {
  if (typeof window === "undefined") return true
  try {
    return window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false"
  } catch {
    return true
  }
}

export function WorkbenchShell({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const router = useRouter()
  const pathname = usePathname()
  // The conversation page draws its own top bar on phones (with the sidebar button).
  const hideMobileBar = pathname.startsWith("/sessions/")
  const { ready, activeAccount } = useWorkbench()
  const isMobile = useIsMobile()
  const {
    drawerOpen,
    setDrawerOpen,
    pendingToolConfirm,
    answerToolConfirm,
    conflict,
    resolveConflictKeepLocal,
    resolveConflictUseCloud,
  } = useAssistant()

  const [registerOpen, setRegisterOpen] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // Settings: open or not, and the section shown (null: phones show the section list).
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null)

  // `/settings` (and old `/settings#vault`-style links) opens the dialog over the home view; closing it goes home.
  const onSettingsRoute = pathname === "/settings"
  const [wasOnSettingsRoute, setWasOnSettingsRoute] = useState(false)
  if (onSettingsRoute !== wasOnSettingsRoute) {
    setWasOnSettingsRoute(onSettingsRoute)
    if (onSettingsRoute) {
      const hash = typeof window === "undefined" ? "" : window.location.hash
      setSettingsSection(settingsSectionFrom(hash) ?? "general")
      setSettingsOpen(true)
    }
  }

  // The sidebar: open or folded away, and its width, as this browser last left them.
  const [sidebarOpen, setSidebarOpenState] = useState(storedSidebarOpen)
  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open)
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(open))
    } catch {
      // Not remembered; the toggle still works.
    }
  }, [])
  const sidebarWidth = usePanelWidth(SIDEBAR_WIDTH)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const viewport = useViewportWidth()
  const sidebarMax = Math.max(SIDEBAR_WIDTH.min, Math.min(420, Math.round(viewport * 0.32)))
  const sidebarShown = Math.min(sidebarWidth.width, sidebarMax)

  // Orches: docked beside the page from 1024px, over it below that, a bottom sheet on phones. Mounted on its first
  // open and kept, so closing slides it out and a half-written message survives.
  const orchesDocked = useMediaQuery("(min-width: 1024px)")
  const [orchesSeen, setOrchesSeen] = useState(drawerOpen)
  if (drawerOpen && !orchesSeen) setOrchesSeen(true)

  useEffect(() => {
    if (ready && !activeAccount) {
      router.replace("/sign-in")
    }
  }, [ready, activeAccount, router])

  // Workbench-wide keys, from anywhere but a terminal: ⌘K search, ⌘⇧O new conversation (⌘N belongs to the browser),
  // ⌘/ the shortcut sheet. ⌘B (sidebar) and ⌘J (assistant) are bound where they act.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      if (e.target instanceof Element && e.target.closest(".xterm")) return
      const key = e.key.toLowerCase()
      if (key === "k" && !e.shiftKey) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if (key === "o" && e.shiftKey) {
        e.preventDefault()
        router.push("/new")
      } else if (key === "/" && !e.shiftKey) {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
      } else if (key === "," && !e.shiftKey) {
        e.preventDefault()
        setSettingsSection(null)
        setSettingsOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [router])

  const ui = useMemo<WorkbenchUi>(
    () => ({
      openPalette: () => setPaletteOpen(true),
      openRegisterDevice: () => setRegisterOpen(true),
      openPairDevice: () => setPairOpen(true),
      openSettings: (section?: SettingsSection) => {
        setSettingsSection(section ?? null)
        setSettingsOpen(true)
      },
    }),
    []
  )

  const revealed = useRevealInTransition(Boolean(ready && activeAccount))

  if (!ready || !activeAccount || !revealed) {
    return <FullPageSpinner label={t("common.loading")} />
  }

  return (
    <WorkbenchUiContext.Provider value={ui}>
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
      data-resizing={sidebarResizing ? "true" : undefined}
      style={{ "--sidebar-width": `${sidebarShown}px` } as CSSProperties}
      className="relative h-svh overflow-hidden"
    >
      <WorkbenchSidebar
        resize={{
          width: sidebarShown,
          min: SIDEBAR_WIDTH.min,
          max: sidebarMax,
          preview: sidebarWidth.preview,
          commit: sidebarWidth.commit,
          reset: sidebarWidth.reset,
          onResizing: setSidebarResizing,
        }}
      />

      <SidebarInset className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {!hideMobileBar && (
          <div className="flex shrink-0 items-center justify-between border-b md:hidden">
            <CollapsedNavBar openLabel={t("shell.openNavigation")} />
            <div className="flex items-center gap-1 pr-3">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("wb.search")}
                onClick={() => setPaletteOpen(true)}
              >
                <SearchIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("shell.quickAssistant")}
                aria-pressed={drawerOpen}
                onClick={() => setDrawerOpen(!drawerOpen)}
              >
                <OrchesIcon className="size-4" />
              </Button>
            </div>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {!hideMobileBar && <SidebarReopen floating />}
          <PageTransition key={pathname} arrival="rise">
            {children}
          </PageTransition>
        </div>
      </SidebarInset>

      {/* Orches (⌘J): docked on the right, sliding in and out, its left edge dragged to resize. */}
      {!isMobile && orchesSeen && (
        <Dock
          open={drawerOpen}
          spec={ORCHES_WIDTH}
          cap={Math.max(ORCHES_WIDTH.min, Math.min(720, Math.round(viewport * 0.45)))}
          overlay={!orchesDocked}
          keepMounted
          resizeLabel={t("shell.resizeOrches")}
          resizeTitle={t("shell.resizeHint")}
        >
          <aside aria-label={t("assistant.title")} className="flex min-h-0 flex-1 flex-col">
            <AssistantPanel compact onClose={() => setDrawerOpen(false)} />
          </aside>
        </Dock>
      )}
      {isMobile && (
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent side="bottom" showCloseButton={false} className="flex flex-col rounded-t-card p-0 data-[side=bottom]:h-[88svh]">
            <SheetTitle className="sr-only">{t("assistant.title")}</SheetTitle>
            <AssistantPanel compact onClose={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>
      )}

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onRegisterDevice={() => setRegisterOpen(true)}
        onPairDevice={() => setPairOpen(true)}
        onShortcuts={() => setShortcutsOpen(true)}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open)
          if (!open && pathname === "/settings") router.replace("/")
        }}
        section={settingsSection}
        onSection={setSettingsSection}
      />

      {/* Global Pi Lite `beforeToolCall` High-Risk Confirmation Dialog */}
      <Dialog
        open={Boolean(pendingToolConfirm)}
        onOpenChange={(open) => {
          if (!open) answerToolConfirm(false)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("assistant.toolConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("assistant.toolConfirmDesc")}</DialogDescription>
          </DialogHeader>
          {pendingToolConfirm && (
            <div className="space-y-2 rounded-xl bg-background p-4 text-xs">
              <div className="font-mono font-semibold text-foreground">
                {pendingToolConfirm.name}
              </div>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap font-mono text-muted-foreground">
                {JSON.stringify(pendingToolConfirm.args, null, 2)}
              </pre>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => answerToolConfirm(false)}>
              {t("assistant.toolDeny")}
            </Button>
            <Button onClick={() => answerToolConfirm(true)}>
              {t("assistant.toolApprove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Global Dual-Fingerprint Assistant Sync Conflict Dialog */}
      <Dialog open={Boolean(conflict)} onOpenChange={() => undefined}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("assistant.conflictTitle")}</DialogTitle>
            <DialogDescription>{t("assistant.conflictDesc")}</DialogDescription>
          </DialogHeader>
          {conflict && (
            <div className="space-y-1.5 rounded-xl bg-background p-4 text-xs">
              <div>
                <span className="text-muted-foreground">Local: </span>
                <span className="font-medium text-foreground">{conflict.localTitle}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Cloud: </span>
                <span className="font-medium text-foreground">{conflict.cloudTitle}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => void resolveConflictUseCloud()}>
              {t("assistant.conflictUseCloud")}
            </Button>
            <Button onClick={() => void resolveConflictKeepLocal()}>
              {t("assistant.conflictKeepLocal")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RegisterDeviceDialog open={registerOpen} onOpenChange={setRegisterOpen} />
      <PairDeviceDialog open={pairOpen} onOpenChange={setPairOpen} />
    </SidebarProvider>
    </WorkbenchUiContext.Provider>
  )
}
