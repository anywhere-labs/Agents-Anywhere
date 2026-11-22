"use client"

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { SearchIcon, SparklesIcon } from "lucide-react"

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
import { PairDeviceDialog } from "@/components/workbench/pair-device-dialog"
import { RegisterDeviceDialog } from "@/components/workbench/register-device-dialog"
import { WorkbenchSidebar } from "@/components/workbench/workbench-sidebar"
import { WorkbenchUiContext, type WorkbenchUi } from "@/components/workbench/workbench-ui"
import { CommandPalette } from "@/components/workbench/command-palette"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { useAssistant } from "@/lib/state/assistant-context"
import { useWorkbench } from "@/lib/state/workbench-context"

export function WorkbenchShell({
  children,
  hideMobileBar = false,
}: {
  children: ReactNode
  /** The page draws its own top bar on phones (with a sidebar trigger), e.g. the conversation page. */
  hideMobileBar?: boolean
}) {
  const { t } = useI18n()
  const router = useRouter()
  const pathname = usePathname()
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

  useEffect(() => {
    if (ready && !activeAccount) {
      router.replace("/sign-in")
    }
  }, [ready, activeAccount, router])

  // ⌘K / Ctrl+K: the search palette, from anywhere in the workbench (not while typing in a terminal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        const target = e.target as HTMLElement | null
        if (target?.closest(".xterm")) return
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const ui = useMemo<WorkbenchUi>(
    () => ({
      openPalette: () => setPaletteOpen(true),
      openRegisterDevice: () => setRegisterOpen(true),
      openPairDevice: () => setPairOpen(true),
    }),
    []
  )

  const revealed = useRevealInTransition(Boolean(ready && activeAccount))

  if (!ready || !activeAccount || !revealed) {
    return <FullPageSpinner label={t("common.loading")} />
  }

  return (
    <WorkbenchUiContext.Provider value={ui}>
    <SidebarProvider className="h-svh overflow-hidden">
      <WorkbenchSidebar />

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
                onClick={() => setDrawerOpen(true)}
              >
                <SparklesIcon className="size-4" />
              </Button>
            </div>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <PageTransition key={pathname} arrival="rise">
            {children}
          </PageTransition>
        </div>
      </SidebarInset>

      {/* Global Portable Assistant drawer (⌘J): right side on wide screens, a bottom sheet on phones */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          className={cn(
            "flex flex-col p-0",
            isMobile ? "data-[side=bottom]:h-[88svh] rounded-t-card" : "w-full sm:max-w-lg"
          )}
        >
          <SheetTitle className="sr-only">{t("assistant.title")}</SheetTitle>
          <AssistantPanel compact />
        </SheetContent>
      </Sheet>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onRegisterDevice={() => setRegisterOpen(true)}
        onPairDevice={() => setPairOpen(true)}
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
