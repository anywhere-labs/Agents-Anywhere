"use client"

import * as React from "react"
import { ExternalLink, FolderTree, PanelLeft, SquareTerminal } from "lucide-react"
import type { GroupImperativeHandle, Layout } from "react-resizable-panels"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useSidebar } from "@/components/ui/sidebar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { NativeWindow } from "@/components/native-window"
import { FilesPanelBody } from "@/components/panels/files-panel"
import { TerminalPanelBody } from "@/components/panels/terminal-panel"
import { SessionDetail } from "@/components/session-detail"
import { useAuth } from "@/components/auth/auth-context"
import { useWorkspace, type PanelId } from "@/components/workspace-context"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"
import type { SessionView as SessionViewModel } from "@/lib/demo-api"

const PANEL_META: Record<PanelId, { titleKey: "panelFiles" | "panelShell"; icon: typeof FolderTree }> = {
  files: { titleKey: "panelFiles", icon: FolderTree },
  terminal: { titleKey: "panelShell", icon: SquareTerminal },
}

const HORIZONTAL_LAYOUT_KEY = "aa-session-runtime-horizontal-layout"
const VERTICAL_LAYOUT_KEY_PREFIX = "aa-session-runtime-vertical-layout"
const SESSION_PANEL_ID = "session-main"
const RUNTIME_PANEL_ID = "runtime-dock"
const HORIZONTAL_DOCK_LAYOUT: Layout = { [SESSION_PANEL_ID]: 66, [RUNTIME_PANEL_ID]: 34 }
const HORIZONTAL_FULL_LAYOUT: Layout = { [SESSION_PANEL_ID]: 100 }

const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

function createEvenLayout(ids: string[]): Layout {
  const size = ids.length > 0 ? 100 / ids.length : 100
  return ids.reduce<Layout>((layout, id) => {
    layout[id] = size
    return layout
  }, {})
}

function normalizeLayout(layout: unknown, panelIds: string[], fallback: Layout): Layout {
  if (!layout || typeof layout !== "object") return fallback

  const source = layout as Record<string, unknown>
  const next: Layout = {}
  for (const id of panelIds) {
    const value = source[id]
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return fallback
    }
    next[id] = value
  }
  return next
}

function readSavedLayout(key: string, panelIds: string[], fallback: Layout): Layout {
  if (typeof window === "undefined") return fallback

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return normalizeLayout(JSON.parse(raw), panelIds, fallback)
  } catch {
    return fallback
  }
}

function writeSavedLayout(key: string, panelIds: string[], layout: Layout) {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(key, JSON.stringify(normalizeLayout(layout, panelIds, layout)))
  } catch {
    // localStorage can be unavailable in private contexts. Resizing should still work.
  }
}

export function SessionView() {
  const { toggleSidebar } = useSidebar()
  const { session: authSession } = useAuth()
  const t = useTranslations("dashboard.session")
  const tActions = useTranslations("dashboard.actions")
  const tCommon = useTranslations("common")
  const {
    activeSessionId,
    sessions,
    connectors,
    panels,
    popupBlocked,
    setPanelMode,
    dismissPopupBlocked,
    upsertSession,
  } = useWorkspace()
  const session = activeSessionId ? sessions.find((item) => item.id === activeSessionId) : null
  const connector = connectors.find((item) => item.id === session?.connectorId)

  const token = authSession?.accessToken ?? null
  const connectorId = session?.connectorId ?? null
  const root = session?.cwd ?? "."
  const panelIds: PanelId[] = ["files", "terminal"]
  const dockedPanels = panelIds.filter((id) => panels[id] === "docked")
  const floatingPanels = panelIds.filter((id) => panels[id] === "floating")
  const hasDock = dockedPanels.length > 0
  const dockedPanelKey = dockedPanels.join("-")
  const horizontalGroupRef = React.useRef<GroupImperativeHandle | null>(null)
  const verticalGroupRef = React.useRef<GroupImperativeHandle | null>(null)
  const verticalLayoutKey = `${VERTICAL_LAYOUT_KEY_PREFIX}:${dockedPanelKey}`
  const verticalPanelIds = React.useMemo(
    () => dockedPanelKey.split("-").filter(Boolean).map((id) => `runtime-${id}`),
    [dockedPanelKey],
  )
  const verticalDefaultLayout = React.useMemo(() => createEvenLayout(verticalPanelIds), [verticalPanelIds])
  const horizontalDefaultLayout = React.useMemo(
    () =>
      hasDock
        ? readSavedLayout(HORIZONTAL_LAYOUT_KEY, [SESSION_PANEL_ID, RUNTIME_PANEL_ID], HORIZONTAL_DOCK_LAYOUT)
        : HORIZONTAL_FULL_LAYOUT,
    [hasDock],
  )
  const savedVerticalDefaultLayout = React.useMemo(
    () => readSavedLayout(verticalLayoutKey, verticalPanelIds, verticalDefaultLayout),
    [verticalLayoutKey, verticalPanelIds, verticalDefaultLayout],
  )

  useIsomorphicLayoutEffect(() => {
    if (!hasDock) return

    horizontalGroupRef.current?.setLayout(horizontalDefaultLayout)
  }, [hasDock, horizontalDefaultLayout])

  useIsomorphicLayoutEffect(() => {
    if (!hasDock || verticalPanelIds.length === 0) return

    verticalGroupRef.current?.setLayout(savedVerticalDefaultLayout)
  }, [hasDock, savedVerticalDefaultLayout, verticalPanelIds.length])

  const renderRuntimePanel = (id: PanelId, options?: { nativeWindow?: boolean }) => {
    if (id === "files") {
      return (
        <FilesPanelBody
          token={token}
          connectorId={connectorId}
          root={root}
          onPopOut={options?.nativeWindow ? undefined : () => setPanelMode("files", "floating")}
          onClose={() => setPanelMode("files", "closed")}
          onPopupBlocked={() => {}}
        />
      )
    }
    if (id === "terminal") {
      return (
        <TerminalPanelBody
          token={token}
          connectorId={connectorId}
          root={root}
          onPopOut={options?.nativeWindow ? undefined : () => setPanelMode("terminal", "floating")}
          onClose={() => setPanelMode("terminal", "closed")}
        />
      )
    }
    return null
  }

  if (!session) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-hidden bg-background text-sm text-muted-foreground">
        {t("noSelected")}
      </div>
    )
  }

  return (
    <>
      <div className="h-full min-h-0 overflow-hidden overscroll-none">
        <ResizablePanelGroup
          direction="horizontal"
          groupRef={horizontalGroupRef}
          defaultLayout={horizontalDefaultLayout}
          onLayoutChanged={(layout) => {
            if (hasDock) writeSavedLayout(HORIZONTAL_LAYOUT_KEY, [SESSION_PANEL_ID, RUNTIME_PANEL_ID], layout)
          }}
          className="h-full min-h-0 w-full overflow-hidden overscroll-none"
        >
          <ResizablePanel id={SESSION_PANEL_ID} defaultSize={hasDock ? "66%" : "100%"} minSize="30%">
            <div className="flex h-full min-h-0 flex-col overflow-hidden overscroll-none">
              <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2">
                <button
                  type="button"
                  aria-label={tActions("expand")}
                  onClick={toggleSidebar}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <PanelLeft className="size-4" />
                </button>
                <h1 className="truncate text-sm font-medium">{session.title}</h1>
                <SessionMetaBadge session={session} connectorName={connector?.name} />
                <div className="ml-auto flex items-center gap-1">
                  <TogglePanelButton id="files" icon={FolderTree} />
                  <TogglePanelButton id="terminal" icon={SquareTerminal} />
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-hidden">
                {token ? (
                  <SessionDetail
                    token={token}
                    sessionId={session.id}
                    fallbackSession={null}
                    onSessionUpdated={upsertSession}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {t("signInRequired")}
                  </div>
                )}
              </div>
            </div>
          </ResizablePanel>

          {hasDock ? <ResizableHandle /> : null}

          {hasDock ? (
            <ResizablePanel id={RUNTIME_PANEL_ID} defaultSize="34%" minSize="20%">
              <ResizablePanelGroup
                key={dockedPanelKey}
                direction="vertical"
                groupRef={verticalGroupRef}
                defaultLayout={savedVerticalDefaultLayout}
                onLayoutChanged={(layout) => writeSavedLayout(verticalLayoutKey, verticalPanelIds, layout)}
                className="h-full min-h-0 overflow-hidden"
              >
                {dockedPanels.map((id, index) => (
                  <React.Fragment key={id}>
                    {index > 0 ? <ResizableHandle /> : null}
                    <ResizablePanel id={`runtime-${id}`} defaultSize={`${100 / dockedPanels.length}%`} minSize="15%">
                      <div className="h-full min-h-0 overflow-hidden">{renderRuntimePanel(id)}</div>
                    </ResizablePanel>
                  </React.Fragment>
                ))}
              </ResizablePanelGroup>
            </ResizablePanel>
          ) : null}
        </ResizablePanelGroup>
      </div>

      {floatingPanels.map((id) => (
        <NativeWindow
          key={id}
          title={t(PANEL_META[id].titleKey)}
          onClose={() => setPanelMode(id, "closed")}
        >
          {renderRuntimePanel(id, { nativeWindow: true })}
        </NativeWindow>
      ))}

      <Dialog open={popupBlocked} onOpenChange={(open) => !open && dismissPopupBlocked()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ExternalLink className="size-4" />
              {t("popupBlockedTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("popupBlockedDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={dismissPopupBlocked}>
              {tCommon("gotIt")}
            </Button>
            <Button onClick={dismissPopupBlocked}>{t("popupBlockedAction")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function SessionMetaBadge({
  session,
  connectorName,
}: {
  session: SessionViewModel
  connectorName?: string | null
}) {
  const t = useTranslations("dashboard.session")
  const sessionMeta = session as SessionViewModel & {
    externalSessionId?: string | null
    lastItemOrderSeq?: number | null
  }
  const label = `${connectorName ?? session.connectorId}/${session.runtime}`
  const rows = [
    [t("device"), connectorName ?? session.connectorId],
    [t("runtime"), session.runtime],
    [t("status"), `${session.status} · ${session.connectorStatus}`],
    [t("workspace"), session.cwd ?? t("none")],
    [t("sessionId"), session.id],
    [t("externalId"), sessionMeta.externalSessionId ?? t("none")],
    [t("timeline"), t("timelineSummary", { count: sessionMeta.lastItemOrderSeq ?? 0, seq: session.updatedSeq })],
    [t("approvals"), t("approvalsPending", { count: 0 })],
  ] as const

  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <Badge variant="secondary" className="shrink-0 cursor-default gap-1.5 font-normal">
          <span
            className={cn(
              "size-1.5 rounded-full",
              session.connectorStatus === "online" ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
          {label}
        </Badge>
      </HoverCardTrigger>
      <HoverCardContent align="end" sideOffset={10} className="w-[420px] rounded-xl p-4">
        <div className="space-y-4">
          <h2 className="text-sm font-semibold">{t("overview")}</h2>
          <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            {rows.map(([name, value]) => (
              <React.Fragment key={name}>
                <div className="text-muted-foreground">{name}</div>
                <div className="min-w-0 truncate font-medium text-popover-foreground">{value}</div>
              </React.Fragment>
            ))}
          </div>
          <Button variant="outline" size="sm" className="font-normal">
            {t("exportTimelineJson")}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

function TogglePanelButton({ id, icon: Icon }: { id: PanelId; icon: typeof FolderTree }) {
  const { panels, setPanelMode } = useWorkspace()
  const t = useTranslations("dashboard.session")
  const active = panels[id] !== "closed"
  return (
    <button
      type="button"
      aria-label={t(PANEL_META[id].titleKey)}
      onClick={() => setPanelMode(id, active ? "closed" : "docked")}
      className={cn(
        "rounded-md p-2 transition-colors hover:bg-accent hover:text-foreground",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon className="size-4" />
    </button>
  )
}
