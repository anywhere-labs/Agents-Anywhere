"use client"

import * as React from "react"

import { SessionDetail, type SessionMemorySnapshot } from "@/components/session-detail"
import {
  clampSessionToolSidebarWidth,
  SessionToolSidebar,
  sessionToolSidebarWidth,
  type SessionToolKind,
  useSessionToolSidebar,
} from "@/components/session-tool-sidebar"
import { SessionViewHeader } from "@/components/session-view-header"
import {
  FloatingRuntimePanels,
  MobileRuntimePanelDrawers,
  PopupBlockedDialog,
} from "@/components/session-runtime-panels"
import { useAuth } from "@/components/auth/auth-context"
import { useWorkspace, type PanelId } from "@/components/workspace-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { dashboardApi } from "@/features/dashboard/api"
import type { Notice, SessionView as SessionViewData, TimelineItem } from "@/features/dashboard/types"
import { sortTimelineItems } from "@/components/session/session-utils"
import { SessionSkeleton } from "@/components/session/session-skeleton"

const PANEL_IDS: PanelId[] = ["files", "terminal"]
const SESSION_TOOL_SIDEBAR_WIDTH_STORAGE_KEY = "agents-anywhere-session-tool-sidebar-width"

type ElementBounds = {
  left: number
  width: number
}

export function SessionView() {
  const { session: authSession } = useAuth()
  const t = useTranslations("dashboard.session")
  const [exporting, setExporting] = React.useState(false)
  const [memorySnapshot, setMemorySnapshot] = React.useState<SessionMemorySnapshot | null>(null)
  const isMobile = useIsMobile()
  const {
    activeSessionId,
    activeSession,
    activeSessionFallback,
    activeSessionPending,
    connectors,
    panels,
    setPanelMode,
    upsertSession,
    reportSessionStreamProgress,
    markSessionRead,
  } = useWorkspace()
  const session = activeSession
  const connector = connectors.find((item) => item.id === session?.connectorId)
  const viewRef = React.useRef<HTMLDivElement | null>(null)
  const viewBounds = useElementBounds(viewRef, Boolean(session))
  const toolSidebar = useSessionToolSidebar()
  const previousToolSidebarExpanded = usePrevious(toolSidebar.expanded)
  const [toolSidebarResizing, setToolSidebarResizing] = React.useState(false)
  const [preferredToolSidebarWidth, setPreferredToolSidebarWidth] = React.useState<number | null>(() => {
    if (typeof window === "undefined") return null
    const stored = Number(window.localStorage.getItem(SESSION_TOOL_SIDEBAR_WIDTH_STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0 ? stored : null
  })

  const token = authSession?.accessToken ?? null
  const connectorId = session?.connectorId ?? null
  const root = session?.cwd ?? "."
  const availablePanelIds = isMobile ? (["files"] satisfies PanelId[]) : PANEL_IDS
  const floatingPanels = availablePanelIds.filter((id) => panels[id] === "floating")
  const defaultToolSidebarWidth = sessionToolSidebarWidth(viewBounds.width)
  const toolSidebarWidth = clampSessionToolSidebarWidth(
    preferredToolSidebarWidth ?? defaultToolSidebarWidth,
    viewBounds.width,
  )
  const reservedSidebarWidth = !isMobile && toolSidebar.open && !toolSidebar.expanded
    ? toolSidebarWidth
    : 0
  const toolSidebarExpanded = !isMobile && toolSidebar.open && toolSidebar.expanded
  const toolSidebarMotionEnabled = !toolSidebarResizing
    && !toolSidebar.expanded
    && previousToolSidebarExpanded !== true

  const handleOpenTool = React.useCallback((kind: SessionToolKind) => {
    if (kind !== "review") setPanelMode(kind, "closed")
    toolSidebar.openTool(kind)
  }, [setPanelMode, toolSidebar.openTool])

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
        notices: memorySnapshot.notices,
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
      const snapshot = await dashboardApi.getSessionSnapshot(token, session.id, 1, {
        reason: "session-view.export-remote",
      })
      const notices: Notice[] = snapshot.notices
      let afterSeq = 0
      let nextSeq = 0
      let serverTime: string | null = snapshot.serverTime

      while (true) {
        const page = await dashboardApi.getSessionTimeline(token, session.id, afterSeq, 500)
        allItems.push(...page.items)
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
          session: snapshot.session as SessionViewData,
          items: sortTimelineItems(allItems),
          notices,
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
    if (activeSessionPending) return <SessionSkeleton />
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-hidden bg-background text-sm text-muted-foreground">
        {t("noSelected")}
      </div>
    )
  }

  return (
    <>
      <div
        ref={viewRef}
        aria-hidden={toolSidebarExpanded || undefined}
        inert={toolSidebarExpanded || undefined}
        className={toolSidebarMotionEnabled
          ? "h-full min-h-0 overflow-hidden overscroll-none bg-background transition-[padding-right] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
          : "h-full min-h-0 overflow-hidden overscroll-none bg-background transition-none"
        }
        style={{ paddingRight: reservedSidebarWidth }}
        onPointerDownCapture={markActiveSessionRead}
        onFocusCapture={markActiveSessionRead}
        onKeyDownCapture={markActiveSessionRead}
      >
        <div className="relative flex h-full min-h-0 flex-col overflow-hidden overscroll-none">
          <SessionViewHeader
            session={session}
            connectorName={connector?.name}
            memorySnapshot={memorySnapshot}
            onExportMemoryTimeline={handleExportMemoryTimeline}
            onExportRemoteTimeline={handleExportRemoteTimeline}
            exporting={exporting}
            toolsOpen={toolSidebar.open}
            toolsExpanded={toolSidebar.expanded}
            toolsOverlayWidth={reservedSidebarWidth}
            toolsMotionEnabled={toolSidebarMotionEnabled}
            onToggleTools={toolSidebar.toggleSidebar}
          />

          <div className="min-h-0 flex-1 overflow-hidden">
            {token ? (
              <SessionDetail
                token={token}
                sessionId={activeSessionId ?? session.id}
                fallbackSession={activeSessionFallback}
                onSessionUpdated={upsertSession}
                onMemorySnapshotUpdated={setMemorySnapshot}
                onStreamProgress={reportSessionStreamProgress}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t("signInRequired")}
              </div>
            )}
          </div>
        </div>
      </div>

      {!isMobile ? (
        <SessionToolSidebar
          controller={toolSidebar}
          hostLeft={viewBounds.left}
          hostWidth={viewBounds.width}
          width={toolSidebarWidth}
          motionEnabled={toolSidebarMotionEnabled}
          token={token}
          connectorId={connectorId}
          connectorDeviceOs={connector?.deviceOs}
          root={root}
          onResizeStart={() => setToolSidebarResizing(true)}
          onWidthChange={setPreferredToolSidebarWidth}
          onWidthChangeEnd={(width) => {
            setPreferredToolSidebarWidth(width)
            setToolSidebarResizing(false)
            window.localStorage.setItem(SESSION_TOOL_SIDEBAR_WIDTH_STORAGE_KEY, String(width))
          }}
          onOpenTool={handleOpenTool}
          onDetachFiles={() => setPanelMode("files", "floating")}
        />
      ) : null}

      {isMobile ? (
        <MobileRuntimePanelDrawers
          token={token}
          connectorId={connectorId}
          connectorDeviceOs={connector?.deviceOs}
          root={root}
          floatingPanels={floatingPanels}
        />
      ) : (
        <FloatingRuntimePanels
          token={token}
          connectorId={connectorId}
          connectorDeviceOs={connector?.deviceOs}
          root={root}
          floatingPanels={floatingPanels}
        />
      )}
      <PopupBlockedDialog />
    </>
  )
}

function usePrevious<T>(value: T) {
  const ref = React.useRef<T | undefined>(undefined)
  React.useEffect(() => {
    ref.current = value
  }, [value])
  return ref.current
}

function useElementBounds(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): ElementBounds {
  const [bounds, setBounds] = React.useState<ElementBounds>({ left: 0, width: 0 })

  React.useLayoutEffect(() => {
    if (!enabled) return
    const element = ref.current
    if (!element) return

    let frame: number | null = null
    const update = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect()
        setBounds((current) => {
          const next = { left: Math.round(rect.left), width: Math.round(rect.width) }
          return current.left === next.left && current.width === next.width ? current : next
        })
        frame = null
      })
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener("resize", update)
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("resize", update)
    }
  }, [enabled, ref])

  return bounds
}

function downloadTimelineJson(
  payload: {
    source: "memory" | "remote"
    session: SessionViewData | null
    items: TimelineItem[]
    notices: Notice[]
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
