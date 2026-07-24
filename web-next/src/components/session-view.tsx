"use client"

import * as React from "react"
import type { Layout } from "react-resizable-panels"

import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { SessionDetail, type SessionMemorySnapshot } from "@/components/session-detail"
import { SessionViewHeader } from "@/components/session-view-header"
import {
  FloatingRuntimePanels,
  PopupBlockedDialog,
  readSavedLayout,
  SessionRuntimePanels,
  writeSavedLayout,
} from "@/components/session-runtime-panels"
import { useAuth } from "@/components/auth/auth-context"
import { useWorkspace, type PanelId } from "@/components/workspace-context"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { dashboardApi } from "@/features/dashboard/api"
import type { Approval, SessionView as SessionViewData, TimelineItem } from "@/features/dashboard/types"
import { sortTimelineItems } from "@/components/session/session-utils"

const HORIZONTAL_LAYOUT_KEY = "aa-session-runtime-horizontal-layout"
const SESSION_PANEL_ID = "session-main"
const RUNTIME_PANEL_ID = "runtime-dock"
const HORIZONTAL_DOCK_LAYOUT: Layout = { [SESSION_PANEL_ID]: 66, [RUNTIME_PANEL_ID]: 34 }
const HORIZONTAL_FULL_LAYOUT: Layout = { [SESSION_PANEL_ID]: 100 }
const PANEL_IDS: PanelId[] = ["files", "terminal"]

export function SessionView() {
  const { session: authSession } = useAuth()
  const t = useTranslations("dashboard.session")
  const [exporting, setExporting] = React.useState(false)
  const [memorySnapshot, setMemorySnapshot] = React.useState<SessionMemorySnapshot | null>(null)
  const {
    activeSessionId,
    sessions,
    connectors,
    panels,
    upsertSession,
    markSessionRead,
  } = useWorkspace()
  const session = activeSessionId ? sessions.find((item) => item.id === activeSessionId) : null
  const connector = connectors.find((item) => item.id === session?.connectorId)

  const token = authSession?.accessToken ?? null
  const connectorId = session?.connectorId ?? null
  const root = session?.cwd ?? "."
  const dockedPanels = PANEL_IDS.filter((id) => panels[id] === "docked")
  const floatingPanels = PANEL_IDS.filter((id) => panels[id] === "floating")
  const hasDock = dockedPanels.length > 0
  const horizontalDefaultLayout = React.useMemo(
    () =>
      hasDock
        ? readSavedLayout(HORIZONTAL_LAYOUT_KEY, [SESSION_PANEL_ID, RUNTIME_PANEL_ID], HORIZONTAL_DOCK_LAYOUT)
        : HORIZONTAL_FULL_LAYOUT,
    [hasDock],
  )

  React.useEffect(() => {
    setMemorySnapshot(null)
  }, [activeSessionId])

  React.useEffect(() => {
    if (activeSessionId) markSessionRead(activeSessionId)
  }, [activeSessionId, markSessionRead])

  const markActiveSessionRead = React.useCallback(() => {
    if (activeSessionId) markSessionRead(activeSessionId)
  }, [activeSessionId, markSessionRead])

  const handleExportMemoryTimeline = React.useCallback(() => {
    if (!session?.id || !memorySnapshot) return
    downloadTimelineJson(
      {
        source: "memory",
        session: memorySnapshot.session,
        items: sortTimelineItems(memorySnapshot.items),
        approvals: memorySnapshot.approvals,
        nextSeq: memorySnapshot.nextSeq,
        hasMore: memorySnapshot.hasMore,
        serverTime: memorySnapshot.serverTime,
        exportedAt: new Date().toISOString(),
      },
      `timeline-memory-${session.id.slice(0, 8)}.json`,
    )
    toast.success(t("timelineExported"))
  }, [memorySnapshot, session?.id, t])

  const handleExportRemoteTimeline = React.useCallback(async () => {
    if (!token || !session?.id || exporting) return
    setExporting(true)
    try {
      const allItems: TimelineItem[] = []
      let approvals: Approval[] = []
      let afterSeq = 0
      let nextSeq = 0
      let sessionSnapshot: SessionViewData | null = null
      let serverTime: string | null = null

      while (true) {
        const page = await dashboardApi.getSessionState(token, session.id, afterSeq, 500)
        allItems.push(...page.items)
        approvals = page.approvals
        sessionSnapshot = page.session
        serverTime = page.serverTime
        nextSeq = page.nextSeq
        if (!page.hasMore) break
        const lastItem = page.items.at(-1)
        if (!lastItem) break
        afterSeq = lastItem.updatedSeq
      }

      downloadTimelineJson(
        {
          source: "remote",
          session: sessionSnapshot,
          items: sortTimelineItems(allItems),
          approvals,
          nextSeq,
          hasMore: false,
          serverTime,
          exportedAt: new Date().toISOString(),
        },
        `timeline-remote-${session.id.slice(0, 8)}.json`,
      )
      toast.success(t("timelineExported"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("timelineExportFailed"))
    } finally {
      setExporting(false)
    }
  }, [exporting, session?.id, t, token])

  if (!session) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-hidden bg-background text-sm text-muted-foreground">
        {t("noSelected")}
      </div>
    )
  }

  return (
    <>
      <div
        className="h-full min-h-0 overflow-hidden overscroll-none"
        onPointerDownCapture={markActiveSessionRead}
        onFocusCapture={markActiveSessionRead}
        onKeyDownCapture={markActiveSessionRead}
      >
        <ResizablePanelGroup
          direction="horizontal"
          defaultLayout={horizontalDefaultLayout}
          onLayoutChanged={(layout) => {
            if (hasDock) writeSavedLayout(HORIZONTAL_LAYOUT_KEY, [SESSION_PANEL_ID, RUNTIME_PANEL_ID], layout)
          }}
          className="h-full min-h-0 w-full overflow-hidden overscroll-none bg-background"
        >
          <ResizablePanel id={SESSION_PANEL_ID} defaultSize={hasDock ? "66%" : "100%"} minSize="30%">
            <div className="relative flex h-full min-h-0 flex-col overflow-hidden overscroll-none">
              <SessionViewHeader
                session={session}
                connectorName={connector?.name}
                memorySnapshot={memorySnapshot}
                onExportMemoryTimeline={handleExportMemoryTimeline}
                onExportRemoteTimeline={handleExportRemoteTimeline}
                exporting={exporting}
              />

              <div className="min-h-0 flex-1 overflow-hidden">
                {token ? (
                  <SessionDetail
                    token={token}
                    sessionId={session.id}
                    // Workspace sessions are compatible with dashboard SessionView for shell fallback.
                    fallbackSession={session as unknown as SessionViewData}
                    onSessionUpdated={upsertSession}
                    onMemorySnapshotUpdated={setMemorySnapshot}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {t("signInRequired")}
                  </div>
                )}
              </div>
            </div>
          </ResizablePanel>

          <SessionRuntimePanels
            token={token}
            connectorId={connectorId}
            connectorDeviceOs={connector?.deviceOs}
            root={root}
            dockedPanels={dockedPanels}
          />
        </ResizablePanelGroup>
      </div>

      <FloatingRuntimePanels
        token={token}
        connectorId={connectorId}
        connectorDeviceOs={connector?.deviceOs}
        root={root}
        floatingPanels={floatingPanels}
      />
      <PopupBlockedDialog />
    </>
  )
}

function downloadTimelineJson(
  payload: {
    source: "memory" | "remote"
    session: SessionViewData | null
    items: TimelineItem[]
    approvals: Approval[]
    nextSeq: number
    hasMore: boolean
    serverTime: string | null
    exportedAt: string
  },
  filename: string,
) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
