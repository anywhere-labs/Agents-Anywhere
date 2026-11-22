"use client"

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState, type ReactNode } from "react"
import { SparklesIcon } from "lucide-react"

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
import { useAssistant } from "@/lib/state/assistant-context"
import { useWorkbench } from "@/lib/state/workbench-context"

export function WorkbenchShell({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const router = useRouter()
  const pathname = usePathname()
  const { ready, activeAccount, preferences } = useWorkbench()
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

  useEffect(() => {
    if (ready && !activeAccount) {
      router.replace("/sign-in")
    }
  }, [ready, activeAccount, router])

  const revealed = useRevealInTransition(Boolean(ready && activeAccount))

  if (!ready || !activeAccount || !revealed) {
    return <FullPageSpinner label={t("common.loading")} />
  }

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <WorkbenchSidebar
        onOpenRegisterDevice={() => setRegisterOpen(true)}
        onOpenPairDevice={() => setPairOpen(true)}
      />

      <SidebarInset className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="flex shrink-0 items-center justify-between border-b md:hidden">
          <CollapsedNavBar openLabel={t("shell.openNavigation")} />
          <div className="pr-3">
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

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <PageTransition key={pathname} arrival="rise">
            {children}
          </PageTransition>

          {/* Subtle floating Quick Assistant button on desktop when AssistantPanel is not already main view */}
          {pathname !== "/assistant" && !(pathname === "/" && preferences.assistantPrimary) && (
            <div className="pointer-events-none fixed right-5 bottom-5 z-30 hidden md:block">
              <Button
                variant="outline"
                size="sm"
                className="pointer-events-auto gap-2 bg-popover shadow-md"
                onClick={() => setDrawerOpen(true)}
              >
                <SparklesIcon className="size-3.5" />
                <span>{t("shell.quickAssistant")}</span>
                <kbd className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  ⌘J
                </kbd>
              </Button>
            </div>
          )}
        </div>
      </SidebarInset>

      {/* Global Right-Hand Portable Assistant Drawer */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-lg">
          <SheetTitle className="sr-only">{t("assistant.title")}</SheetTitle>
          <AssistantPanel compact />
        </SheetContent>
      </Sheet>

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
              {typeof pendingToolConfirm.args.code === "string" ? (
                <>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-foreground">
                    {pendingToolConfirm.args.code}
                  </pre>
                  {Object.keys(pendingToolConfirm.args).some((k) => k !== "code") && (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-muted-foreground">
                      {JSON.stringify(
                        Object.fromEntries(
                          Object.entries(pendingToolConfirm.args).filter(([k]) => k !== "code")
                        ),
                        null,
                        2
                      )}
                    </pre>
                  )}
                </>
              ) : (
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap font-mono text-muted-foreground">
                  {JSON.stringify(pendingToolConfirm.args, null, 2)}
                </pre>
              )}
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
  )
}
