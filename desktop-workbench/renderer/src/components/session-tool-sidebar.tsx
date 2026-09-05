"use client"

/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4 */
/* Hallmark · component: desktop tool sidebar · genre: modern-minimal · theme: existing application system
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: inherited from the application semantic tokens
 */

import * as React from "react"
import { createPortal } from "react-dom"
import type { LucideIcon } from "lucide-react"
import {
  File,
  FileDiff,
  Maximize2,
  Minimize2,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { FilesPanelBody } from "@/components/panels/files-panel"
import { TerminalSessionPanel } from "@/components/panels/terminal-panel"
import { SessionReviewPanel } from "@/components/session/session-review-panel"
import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { useDashboardSidebarControls } from "@/components/dashboard-sidebar-controls"
import { useAuth } from "@/components/auth/auth-context"
import { useWorkspace, type PanelId } from "@/components/workspace-context"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  createSessionFilePreviewTab,
  createSessionToolTab,
  type SessionToolKind,
  type SessionToolTabsAction,
  type SessionToolTabsState,
} from "@/components/session-tool-tabs"
import {
  useSessionToolSidebarStore,
  useSessionToolSidebarHostBounds,
  useStoredSessionToolSidebarContext,
  useStoredSessionToolSidebarIds,
  useStoredSessionToolSidebarState,
} from "@/components/session-tool-sidebar-state"
import type { SessionFilePreviewTarget } from "@/components/session/session-file-preview-context"
import { dashboardApi } from "@/features/dashboard/api"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import { useIsMobile } from "@/hooks/use-mobile"
import { isApiError } from "@/lib/api/errors"
import { createClientId } from "@/lib/id"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

export type { SessionToolKind } from "@/components/session-tool-tabs"

const TOOL_META: Record<
  SessionToolKind,
  { icon: LucideIcon; labelKey: "review" | "terminal" | "files" }
> = {
  review: { icon: FileDiff, labelKey: "review" },
  terminal: { icon: SquareTerminal, labelKey: "terminal" },
  files: { icon: File, labelKey: "files" },
}

const TOOL_KINDS: SessionToolKind[] = ["review", "terminal", "files"]
const SESSION_TOOL_SIDEBAR_MIN_WIDTH = 360
const SESSION_TOOL_SIDEBAR_MAX_WIDTH = 880
const SESSION_TOOL_MAIN_MIN_WIDTH = 360
const SESSION_TOOL_SIDEBAR_RESIZE_STEP = 16

export type SessionToolSidebarController = SessionToolTabsState & {
  toggleSidebar: () => void
  collapseSidebar: () => void
  toggleExpanded: () => void
  openTool: (kind: SessionToolKind) => void
  openFilePreview: (target: SessionFilePreviewTarget) => void
  activateTab: (id: string) => void
  closeTab: (id: string) => Promise<boolean>
  setTabTitle: (id: string, title: string | null) => void
  setPreferredWidth: (width: number) => void
  setResizing: (resizing: boolean) => void
}

type SessionToolSidebarOptions = {
  sessionId: string | null
  userId: string | null
  token: string | null
  connectorId: string | null
  root: string
  terminalLabel: string
  onTerminalError?: (message: string) => void
}

export function useSessionToolSidebar({
  sessionId,
  userId,
  token,
  connectorId,
  root,
  terminalLabel,
  onTerminalError,
}: SessionToolSidebarOptions): SessionToolSidebarController {
  const effectiveRoot = root.trim() || "."
  const store = useSessionToolSidebarStore()
  const state = useStoredSessionToolSidebarState(sessionId)
  const closingTerminalIdsRef = React.useRef(new Set<string>())

  const dispatch = React.useCallback((action: SessionToolTabsAction) => {
    if (sessionId) store.dispatch(sessionId, action)
  }, [sessionId, store])

  const toggleSidebar = React.useCallback(() => dispatch({ type: "toggle-sidebar" }), [dispatch])
  const collapseSidebar = React.useCallback(() => dispatch({ type: "collapse-sidebar" }), [dispatch])
  const toggleExpanded = React.useCallback(() => dispatch({ type: "toggle-expanded" }), [dispatch])
  const openTool = React.useCallback((kind: SessionToolKind) => {
    if (!sessionId || store.isShuttingDown()) return
    if (kind !== "terminal") {
      dispatch({ type: "open-tool", tab: createSessionToolTab(kind, kind) })
      return
    }

    const tabId = createClientId("terminal_pending")
    const title = nextTerminalTitle(store.getState(sessionId), terminalLabel)
    dispatch({ type: "open-tool", tab: createSessionToolTab(tabId, "terminal", title) })

    if (!userId || !token || !connectorId) return
    const creation = dashboardApi.connectorTerminalCreateV2(token, connectorId, effectiveRoot, {
      cols: 80,
      rows: 24,
      label: title,
    }).then(async (response) => {
      let terminal = response.result
      let trackedByDesktop = false
      try {
        trackedByDesktop = await trackDesktopTerminal(
          userId,
          token,
          connectorId,
          terminal.terminalId,
        )
      } catch (error) {
        await closeTerminalWithRetry(token, connectorId, terminal.terminalId).catch(() => undefined)
        throw error
      }
      if (store.isShuttingDown()) {
        if (!trackedByDesktop) {
          await closeTerminalWithRetry(token, connectorId, terminal.terminalId)
        }
        return
      }
      if (trackedByDesktop) {
        try {
          const promoted = await dashboardApi.connectorTerminalSetPersistenceV2(
            token,
            connectorId,
            terminal.terminalId,
            true,
          )
          terminal = promoted.result
        } catch (promotionError) {
          try {
            await closeDesktopTerminalOrFallback(token, connectorId, terminal.terminalId)
          } catch (cleanupError) {
            await trackDesktopTerminal(
              userId,
              token,
              connectorId,
              terminal.terminalId,
            ).catch(() => undefined)
            if (!store.isShuttingDown()) {
              const tabStillExists = store.getState(sessionId).tabs.some((tab) => tab.id === tabId)
              if (!tabStillExists) {
                dispatch({ type: "open-tool", tab: createSessionToolTab(tabId, "terminal", title) })
              }
              dispatch({ type: "resolve-terminal", id: tabId, terminal })
              onTerminalError?.(
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              )
            }
            return
          }
          await untrackDesktopTerminal(connectorId, terminal.terminalId).catch(() => undefined)
          throw promotionError
        }
      }
      if (store.isShuttingDown()) return
      const tabStillExists = store.getState(sessionId).tabs.some((tab) => tab.id === tabId)
      if (!tabStillExists) {
        try {
          await closeDesktopTerminalOrFallback(token, connectorId, terminal.terminalId)
          await untrackDesktopTerminal(connectorId, terminal.terminalId).catch(() => undefined)
        } catch (cleanupError) {
          await trackDesktopTerminal(
            userId,
            token,
            connectorId,
            terminal.terminalId,
          ).catch(() => undefined)
          if (!store.isShuttingDown()) {
            dispatch({ type: "open-tool", tab: createSessionToolTab(tabId, "terminal", title) })
            dispatch({ type: "resolve-terminal", id: tabId, terminal })
            onTerminalError?.(
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            )
          }
        }
        return
      }
      dispatch({ type: "resolve-terminal", id: tabId, terminal })
    }).catch((error: unknown) => {
      if (store.isShuttingDown()) return
      const message = error instanceof Error ? error.message : String(error)
      dispatch({ type: "fail-terminal", id: tabId, error: message })
    })
    store.trackTerminalTask(creation)
  }, [connectorId, dispatch, effectiveRoot, sessionId, store, terminalLabel, token, userId])
  const openFilePreview = React.useCallback((target: SessionFilePreviewTarget) => {
    if (!sessionId || store.isShuttingDown()) return
    const tabId = createClientId("files_preview")
    dispatch({ type: "open-tool", tab: createSessionFilePreviewTab(tabId, target) })
  }, [dispatch, sessionId, store])
  const activateTab = React.useCallback(
    (id: string) => dispatch({ type: "activate-tab", id }),
    [dispatch],
  )
  const closeTab = React.useCallback(async (id: string) => {
    if (!sessionId) return false
    const tab = store.getState(sessionId).tabs.find((item) => item.id === id)
    if (!tab) return false
    if (tab.kind !== "terminal" || !tab.terminal) {
      dispatch({ type: "close-tab", id })
      return true
    }
    if (!userId || !token || !connectorId) return false
    const terminalId = tab.terminal.terminalId
    if (closingTerminalIdsRef.current.has(terminalId)) return false

    closingTerminalIdsRef.current.add(terminalId)
    const closing = closeDesktopTerminalOrFallback(token, connectorId, terminalId)
    try {
      await store.trackTerminalTask(closing)
      await untrackDesktopTerminal(connectorId, terminalId).catch(() => undefined)
      dispatch({ type: "close-tab", id })
      return true
    } catch (error: unknown) {
      await trackDesktopTerminal(userId, token, connectorId, terminalId).catch(() => undefined)
      onTerminalError?.(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      closingTerminalIdsRef.current.delete(terminalId)
    }
  }, [connectorId, dispatch, onTerminalError, sessionId, store, token, userId])
  const setTabTitle = React.useCallback(
    (id: string, title: string | null) => dispatch({ type: "set-tab-title", id, title }),
    [dispatch],
  )
  const setPreferredWidth = React.useCallback(
    (width: number) => dispatch({ type: "set-preferred-width", width }),
    [dispatch],
  )
  const setResizing = React.useCallback(
    (resizing: boolean) => dispatch({ type: "set-resizing", resizing }),
    [dispatch],
  )

  return React.useMemo(
    () => ({
      ...state,
      toggleSidebar,
      collapseSidebar,
      toggleExpanded,
      openTool,
      openFilePreview,
      activateTab,
      closeTab,
      setTabTitle,
      setPreferredWidth,
      setResizing,
    }),
    [
      activateTab,
      closeTab,
      collapseSidebar,
      openFilePreview,
      openTool,
      setTabTitle,
      setPreferredWidth,
      setResizing,
      state,
      toggleExpanded,
      toggleSidebar,
    ],
  )
}

async function trackDesktopTerminal(
  userId: string,
  token: string,
  connectorId: string,
  terminalId: string,
) {
  const trackTerminal = getDesktopWorkbenchBridge()?.lifecycle?.trackTerminal
  if (!trackTerminal) return false
  await trackTerminal({ connectorId, terminalId, userId, token })
  return true
}

async function untrackDesktopTerminal(connectorId: string, terminalId: string) {
  await getDesktopWorkbenchBridge()?.lifecycle?.untrackTerminal?.({ connectorId, terminalId })
}

async function closeDesktopTerminalOrFallback(
  token: string,
  connectorId: string,
  terminalId: string,
) {
  const closeTerminal = getDesktopWorkbenchBridge()?.lifecycle?.closeTerminal
  if (closeTerminal) {
    const result = await closeTerminal({ connectorId, terminalId })
    if (result.handled) return
  }
  await closeTerminalWithRetry(token, connectorId, terminalId)
}

async function closeTerminalWithRetry(
  token: string,
  connectorId: string,
  terminalId: string,
) {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await dashboardApi.connectorTerminalCloseV2(
        token,
        connectorId,
        terminalId,
        AbortSignal.timeout(4_000),
      )
    } catch (error: unknown) {
      if (isApiError(error) && error.status === 404) return
      lastError = error
      if (attempt < 2) await delay(250 * (attempt + 1))
    }
  }
  throw lastError
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function nextTerminalTitle(state: SessionToolTabsState, baseLabel: string) {
  const labels = new Set(
    state.tabs
      .filter((tab) => tab.kind === "terminal" && tab.title)
      .map((tab) => tab.title),
  )
  if (!labels.has(baseLabel)) return baseLabel
  let sequence = 2
  while (labels.has(`${baseLabel} ${sequence}`)) sequence += 1
  return `${baseLabel} ${sequence}`
}

function sessionToolSidebarResizeBounds(hostWidth: number) {
  const available = Math.max(0, hostWidth)
  const max = Math.min(
    available,
    SESSION_TOOL_SIDEBAR_MAX_WIDTH,
    Math.max(SESSION_TOOL_SIDEBAR_MIN_WIDTH, available - SESSION_TOOL_MAIN_MIN_WIDTH),
  )
  return {
    min: Math.min(SESSION_TOOL_SIDEBAR_MIN_WIDTH, max),
    max,
  }
}

export function clampSessionToolSidebarWidth(width: number, hostWidth: number) {
  if (hostWidth <= 0) return 0
  const bounds = sessionToolSidebarResizeBounds(hostWidth)
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)))
}

export function sessionToolSidebarWidth(hostWidth: number) {
  const available = Math.max(0, hostWidth)
  if (available === 0) return 0
  return clampSessionToolSidebarWidth(
    Math.max(SESSION_TOOL_SIDEBAR_MIN_WIDTH, Math.min(680, available * 0.42)),
    available,
  )
}

export function SessionToolSidebarsHost() {
  const { session: authSession } = useAuth()
  const {
    page,
    activeSessionId,
    activeSession,
    connectors,
    setPanelMode,
  } = useWorkspace()
  const isMobile = useIsMobile()
  const t = useTranslations("dashboard.session")
  const store = useSessionToolSidebarStore()
  const sessionIds = useStoredSessionToolSidebarIds()
  const hostBounds = useSessionToolSidebarHostBounds()
  const connector = connectors.find((item) => item.id === activeSession?.connectorId)
  const ownedSessionIds = authSession
    ? sessionIds.filter((sessionId) => (
        store.getContext(sessionId)?.ownerUserId === authSession.userId
      ))
    : []

  React.useEffect(() => {
    if (!activeSessionId || !activeSession) return
    store.setContext(activeSessionId, {
      ownerUserId: authSession?.userId ?? "",
      connectorId: activeSession.connectorId,
      connectorDeviceOs: connector?.deviceOs,
      root: activeSession.cwd || ".",
      terminalLabel: t("tools.terminal"),
    })
  }, [activeSession, activeSessionId, authSession?.userId, connector?.deviceOs, store, t])

  return (
    <>
      {ownedSessionIds.map((sessionId) => (
        <PersistentSessionToolSidebar
          key={store.getHostKey(sessionId)}
          sessionId={sessionId}
          presented={!isMobile && page === "session" && activeSessionId === sessionId}
          token={authSession?.accessToken ?? null}
          userId={authSession?.userId ?? null}
          hostLeft={hostBounds.left}
          hostWidth={hostBounds.width}
          setPanelMode={setPanelMode}
        />
      ))}
    </>
  )
}

function PersistentSessionToolSidebar({
  sessionId,
  presented,
  token,
  userId,
  hostLeft,
  hostWidth,
  setPanelMode,
}: {
  sessionId: string
  presented: boolean
  token: string | null
  userId: string | null
  hostLeft: number
  hostWidth: number
  setPanelMode: (id: PanelId, mode: "docked" | "floating" | "closed") => void
}) {
  const context = useStoredSessionToolSidebarContext(sessionId)
  const handleTerminalError = React.useCallback((message: string) => toast.error(message), [])
  const controller = useSessionToolSidebar({
    sessionId,
    userId,
    token,
    connectorId: context?.connectorId ?? null,
    root: context?.root ?? ".",
    terminalLabel: context?.terminalLabel ?? "Terminal",
    onTerminalError: handleTerminalError,
  })
  const previousExpanded = usePreviousValue(controller.expanded)
  const defaultWidth = sessionToolSidebarWidth(hostWidth)
  const width = clampSessionToolSidebarWidth(
    controller.preferredWidth ?? defaultWidth,
    hostWidth,
  )
  const motionEnabled = !controller.resizing
    && !controller.expanded
    && previousExpanded !== true
  const handleOpenTool = React.useCallback((kind: SessionToolKind) => {
    if (kind !== "review") setPanelMode(kind, "closed")
    controller.openTool(kind)
  }, [controller.openTool, setPanelMode])

  if (!context) return null

  return (
    <SessionToolSidebar
      sessionId={sessionId}
      controller={controller}
      presented={presented}
      hostLeft={hostLeft}
      hostWidth={hostWidth}
      width={width}
      motionEnabled={motionEnabled}
      token={token}
      connectorId={context.connectorId}
      connectorDeviceOs={context.connectorDeviceOs}
      root={context.root}
      onResizeStart={() => controller.setResizing(true)}
      onWidthChange={controller.setPreferredWidth}
      onWidthChangeEnd={(nextWidth) => {
        controller.setPreferredWidth(nextWidth)
        controller.setResizing(false)
      }}
      onOpenTool={handleOpenTool}
    />
  )
}

function usePreviousValue<T>(value: T) {
  const ref = React.useRef<T | undefined>(undefined)
  React.useEffect(() => {
    ref.current = value
  }, [value])
  return ref.current
}

type SessionToolSidebarProps = {
  sessionId: string
  controller: SessionToolSidebarController
  presented: boolean
  hostLeft: number
  hostWidth: number
  width: number
  motionEnabled: boolean
  token: string | null
  connectorId: string | null
  connectorDeviceOs?: string | null
  root: string
  onResizeStart: () => void
  onWidthChange: (width: number) => void
  onWidthChangeEnd: (width: number) => void
  onOpenTool: (kind: SessionToolKind) => void
}

export function SessionToolSidebar({
  sessionId,
  controller,
  presented,
  hostLeft,
  hostWidth,
  width,
  motionEnabled,
  token,
  connectorId,
  connectorDeviceOs,
  root,
  onResizeStart,
  onWidthChange,
  onWidthChangeEnd,
  onOpenTool,
}: SessionToolSidebarProps) {
  const t = useTranslations("dashboard.session.tools")
  const dashboardSidebarControls = useDashboardSidebarControls()
  const domIdPrefix = React.useId()
  const tabButtonRefs = React.useRef(new Map<string, HTMLButtonElement>())
  const newTabButtonRef = React.useRef<HTMLButtonElement | null>(null)
  const launcherButtonRef = React.useRef<HTMLButtonElement | null>(null)
  const resizeStateRef = React.useRef<{
    pointerId: number
    startClientX: number
    startWidth: number
    currentWidth: number
  } | null>(null)
  const restoreDocumentPointerStylesRef = React.useRef<(() => void) | null>(null)
  const resizeBounds = sessionToolSidebarResizeBounds(hostWidth)
  const showDashboardSidebarToggle = controller.expanded && dashboardSidebarControls?.open === false
  const restoreDocumentPointerStyles = React.useCallback(() => {
    restoreDocumentPointerStylesRef.current?.()
    restoreDocumentPointerStylesRef.current = null
  }, [])

  React.useEffect(() => restoreDocumentPointerStyles, [restoreDocumentPointerStyles])

  React.useEffect(() => {
    if (!presented || !controller.open) return
    const frame = window.requestAnimationFrame(() => {
      if (controller.activeTabId) {
        tabButtonRefs.current.get(controller.activeTabId)?.focus()
      } else {
        launcherButtonRef.current?.focus()
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [controller.activeTabId, controller.open, presented])

  if (width === 0 || typeof document === "undefined") return null

  const panelStyle: React.CSSProperties = controller.expanded
    ? { left: hostLeft, width: hostWidth, transform: "translateX(0)" }
    : {
        left: hostLeft + hostWidth - width,
        width,
        transform: controller.open ? "translateX(0)" : "translateX(100%)",
      }

  const focusTab = (id: string) => {
    controller.activateTab(id)
    window.requestAnimationFrame(() => tabButtonRefs.current.get(id)?.focus())
  }

  const closeTabAndRestoreFocus = async (id: string) => {
    const closedIndex = controller.tabs.findIndex((tab) => tab.id === id)
    const remainingTabs = controller.tabs.filter((tab) => tab.id !== id)
    const nextTabId = controller.activeTabId === id
      ? remainingTabs[Math.min(closedIndex, remainingTabs.length - 1)]?.id ?? null
      : controller.activeTabId

    const closed = await controller.closeTab(id)
    if (!closed) return
    window.requestAnimationFrame(() => {
      if (nextTabId) tabButtonRefs.current.get(nextTabId)?.focus()
      else newTabButtonRef.current?.focus()
    })
  }

  const finishResize = (target: HTMLDivElement, pointerId: number) => {
    const resizeState = resizeStateRef.current
    if (!resizeState || resizeState.pointerId !== pointerId) return
    resizeStateRef.current = null
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    restoreDocumentPointerStyles()
    onWidthChangeEnd(resizeState.currentWidth)
  }

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null
    if (event.key === "ArrowLeft") nextWidth = width + SESSION_TOOL_SIDEBAR_RESIZE_STEP
    else if (event.key === "ArrowRight") nextWidth = width - SESSION_TOOL_SIDEBAR_RESIZE_STEP
    else if (event.key === "Home") nextWidth = resizeBounds.min
    else if (event.key === "End") nextWidth = resizeBounds.max
    if (nextWidth === null) return

    event.preventDefault()
    const clampedWidth = clampSessionToolSidebarWidth(nextWidth, hostWidth)
    onWidthChange(clampedWidth)
    onWidthChangeEnd(clampedWidth)
  }

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).getAttribute("role") !== "tab") return
    if (!controller.activeTabId || controller.tabs.length === 0) return

    const currentIndex = controller.tabs.findIndex((tab) => tab.id === controller.activeTabId)
    let nextIndex = currentIndex
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + controller.tabs.length) % controller.tabs.length
    else if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % controller.tabs.length
    else if (event.key === "Home") nextIndex = 0
    else if (event.key === "End") nextIndex = controller.tabs.length - 1
    else return

    event.preventDefault()
    const nextTab = controller.tabs[nextIndex]
    if (nextTab) focusTab(nextTab.id)
  }

  return createPortal(
    <aside
      aria-label={t("sidebarLabel")}
      aria-hidden={!presented || !controller.open}
      inert={!presented || !controller.open ? true : undefined}
      className={cn(
        "fixed inset-y-0 z-40 flex min-w-0 flex-col overflow-hidden border-l border-border bg-background text-foreground",
        presented ? "visible" : "invisible",
        presented && controller.open ? "pointer-events-auto" : "pointer-events-none",
        motionEnabled && !controller.expanded
          ? "will-change-transform transition-transform duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
          : "transition-none",
      )}
      style={panelStyle}
    >
      {controller.open && !controller.expanded ? (
        <div
          role="separator"
          aria-label={t("sidebarLabel")}
          aria-orientation="vertical"
          aria-valuemin={resizeBounds.min}
          aria-valuemax={resizeBounds.max}
          aria-valuenow={width}
          tabIndex={0}
          className="aa-window-no-drag absolute inset-y-0 left-0 z-20 w-2 cursor-col-resize touch-none bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onKeyDown={handleResizeKeyDown}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            resizeStateRef.current = {
              pointerId: event.pointerId,
              startClientX: event.clientX,
              startWidth: width,
              currentWidth: width,
            }
            const body = document.body
            const previousCursor = body.style.cursor
            const previousUserSelect = body.style.userSelect
            body.style.cursor = "col-resize"
            body.style.userSelect = "none"
            restoreDocumentPointerStylesRef.current = () => {
              body.style.cursor = previousCursor
              body.style.userSelect = previousUserSelect
            }
            onResizeStart()
          }}
          onPointerMove={(event) => {
            const resizeState = resizeStateRef.current
            if (!resizeState || resizeState.pointerId !== event.pointerId) return
            const nextWidth = clampSessionToolSidebarWidth(
              resizeState.startWidth + resizeState.startClientX - event.clientX,
              hostWidth,
            )
            resizeState.currentWidth = nextWidth
            onWidthChange(nextWidth)
          }}
          onPointerUp={(event) => finishResize(event.currentTarget, event.pointerId)}
          onPointerCancel={(event) => finishResize(event.currentTarget, event.pointerId)}
          onLostPointerCapture={(event) => finishResize(event.currentTarget, event.pointerId)}
        />
      ) : null}

      <div className="aa-window-drag flex h-11 shrink-0 items-center gap-1 bg-background pl-1.5 pr-3">
        {showDashboardSidebarToggle ? (
          <>
            <div className="w-[6.5rem] shrink-0" aria-hidden="true" />
            <DashboardSidebarToggle
              showOnDesktop
              className="aa-window-no-drag rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            />
          </>
        ) : null}
        <div
          role="tablist"
          aria-label={t("tabsLabel")}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
          onKeyDown={handleTabKeyDown}
        >
          {controller.tabs.map((tab) => {
            const meta = TOOL_META[tab.kind]
            const Icon = meta.icon
            const active = controller.activeTabId === tab.id
            const label = tab.title || t(meta.labelKey)

            return (
              <div
                key={tab.id}
                className={cn(
                  "aa-window-no-drag group flex min-w-0 max-w-48 flex-1 basis-0 items-center overflow-hidden rounded-xl transition-colors hover:bg-secondary focus-within:bg-secondary",
                  active && "bg-secondary text-secondary-foreground",
                )}
              >
                <Button
                  ref={(element) => {
                    if (element) tabButtonRefs.current.set(tab.id, element)
                    else tabButtonRefs.current.delete(tab.id)
                  }}
                  type="button"
                  id={`${domIdPrefix}-tab-${tab.id}`}
                  role="tab"
                  variant="ghost"
                  size="sm"
                  aria-selected={active}
                  aria-controls={`${domIdPrefix}-panel-${tab.id}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => controller.activateTab(tab.id)}
                  className="h-8 min-w-0 flex-1 justify-start rounded-xl px-2 hover:bg-transparent"
                >
                  <Icon data-icon="inline-start" />
                  <span className="truncate">{label}</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("closeTab", { title: label })}
                  title={t("closeTab", { title: label })}
                  onClick={() => void closeTabAndRestoreFocus(tab.id)}
                  className={cn(
                    "mr-0.5 shrink-0 rounded-lg opacity-0 transition-opacity hover:bg-transparent focus-visible:opacity-100",
                    active
                      ? "opacity-100"
                      : "pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
                  )}
                >
                  <X />
                </Button>
              </div>
            )
          })}
        </div>

        <ToolMenu
          triggerRef={newTabButtonRef}
          onOpenTool={onOpenTool}
        />

        <div className="aa-window-no-drag ml-1 flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={controller.expanded ? t("restore") : t("expand")}
            title={controller.expanded ? t("restore") : t("expand")}
            aria-pressed={controller.expanded}
            onClick={controller.toggleExpanded}
            className="rounded-lg"
          >
            {controller.expanded ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <div className="size-8 shrink-0" aria-hidden="true" />
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {controller.tabs.length === 0 ? (
          <ToolLauncher
            firstButtonRef={launcherButtonRef}
            onOpenTool={onOpenTool}
          />
        ) : (
          controller.tabs.map((tab) => {
            const active = controller.activeTabId === tab.id
            const panelActive = presented && active
            return (
              <section
                key={tab.id}
                id={`${domIdPrefix}-panel-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`${domIdPrefix}-tab-${tab.id}`}
                aria-hidden={!panelActive}
                className={cn(
                  "absolute inset-0 min-h-0 overflow-hidden",
                  panelActive ? "visible pointer-events-auto" : "invisible pointer-events-none",
                )}
              >
                {tab.kind === "review" ? (
                  <SessionReviewPanel
                    sessionId={sessionId}
                    token={token}
                    root={root}
                    connectorDeviceOs={connectorDeviceOs}
                    active={panelActive}
                  />
                ) : null}
                {tab.kind === "terminal" ? (
                  <TerminalSessionPanel
                    key={tab.terminal?.terminalId ?? tab.id}
                    token={token}
                    connectorId={connectorId}
                    terminal={tab.terminal}
                    active={panelActive}
                    creationError={tab.error}
                  />
                ) : null}
                {tab.kind === "files" ? (
                  <SessionFilesToolPanel
                    tabId={tab.id}
                    filePreview={tab.filePreview}
                    token={token}
                    connectorId={connectorId}
                    connectorDeviceOs={connectorDeviceOs}
                    root={root}
                    onTitleChange={controller.setTabTitle}
                  />
                ) : null}
              </section>
            )
          })
        )}
      </div>
    </aside>,
    document.body,
  )
}

function SessionFilesToolPanel({
  tabId,
  filePreview,
  token,
  connectorId,
  connectorDeviceOs,
  root,
  onTitleChange,
}: {
  tabId: string
  filePreview: SessionFilePreviewTarget | null
  token: string | null
  connectorId: string | null
  connectorDeviceOs?: string | null
  root: string
  onTitleChange: (id: string, title: string | null) => void
}) {
  const handleTitleChange = React.useCallback(
    (title: string | null) => onTitleChange(tabId, title),
    [onTitleChange, tabId],
  )

  return (
    <FilesPanelBody
      token={token}
      connectorId={connectorId}
      connectorDeviceOs={connectorDeviceOs}
      root={filePreview?.root ?? root}
      variant="tab"
      initialFile={filePreview}
      onSelectedFileNameChange={handleTitleChange}
    />
  )
}

function ToolMenu({
  triggerRef,
  onOpenTool,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onOpenTool: (kind: SessionToolKind) => void
}) {
  const t = useTranslations("dashboard.session.tools")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("newTab")}
          title={t("newTab")}
          className="aa-window-no-drag shrink-0 rounded-lg"
        >
          <Plus />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-52">
        <DropdownMenuGroup>
          {TOOL_KINDS.map((kind) => {
            const meta = TOOL_META[kind]
            const Icon = meta.icon
            return (
              <DropdownMenuItem key={kind} onSelect={() => onOpenTool(kind)}>
                <Icon />
                {t(meta.labelKey)}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ToolLauncher({
  firstButtonRef,
  onOpenTool,
}: {
  firstButtonRef: React.RefObject<HTMLButtonElement | null>
  onOpenTool: (kind: SessionToolKind) => void
}) {
  const t = useTranslations("dashboard.session.tools")

  return (
    <nav aria-label={t("navigationLabel")} className="flex h-full items-center justify-center p-8">
      <div className="flex w-full max-w-md flex-col gap-2">
        {TOOL_KINDS.map((kind, index) => {
          const meta = TOOL_META[kind]
          const Icon = meta.icon
          return (
            <Button
              ref={index === 0 ? firstButtonRef : undefined}
              key={kind}
              type="button"
              variant="secondary"
              size="lg"
              onClick={() => onOpenTool(kind)}
              className="h-12 w-full justify-start rounded-xl px-4 text-base font-normal"
            >
              <Icon data-icon="inline-start" />
              {t(meta.labelKey)}
            </Button>
          )
        })}
      </div>
    </nav>
  )
}
