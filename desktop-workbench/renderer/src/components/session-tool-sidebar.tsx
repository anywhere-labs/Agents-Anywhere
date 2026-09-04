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
import { TerminalPanelBody } from "@/components/panels/terminal-panel"
import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { useDashboardSidebarControls } from "@/components/dashboard-sidebar-controls"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"

export type SessionToolKind = "review" | "terminal" | "files"

type SessionToolTab = {
  id: SessionToolKind
  kind: SessionToolKind
}

type SessionToolSidebarState = {
  open: boolean
  expanded: boolean
  tabs: SessionToolTab[]
  activeTabId: SessionToolKind | null
}

type SessionToolSidebarAction =
  | { type: "toggle-sidebar" }
  | { type: "collapse-sidebar" }
  | { type: "toggle-expanded" }
  | { type: "open-tool"; kind: SessionToolKind }
  | { type: "activate-tab"; id: SessionToolKind }
  | { type: "close-tab"; id: SessionToolKind }

const INITIAL_STATE: SessionToolSidebarState = {
  open: false,
  expanded: false,
  tabs: [],
  activeTabId: null,
}

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

export type SessionToolSidebarController = SessionToolSidebarState & {
  toggleSidebar: () => void
  collapseSidebar: () => void
  toggleExpanded: () => void
  openTool: (kind: SessionToolKind) => void
  activateTab: (id: SessionToolKind) => void
  closeTab: (id: SessionToolKind) => void
}

export function useSessionToolSidebar(): SessionToolSidebarController {
  const [state, dispatch] = React.useReducer(sessionToolSidebarReducer, INITIAL_STATE)

  const toggleSidebar = React.useCallback(() => dispatch({ type: "toggle-sidebar" }), [])
  const collapseSidebar = React.useCallback(() => dispatch({ type: "collapse-sidebar" }), [])
  const toggleExpanded = React.useCallback(() => dispatch({ type: "toggle-expanded" }), [])
  const openTool = React.useCallback(
    (kind: SessionToolKind) => dispatch({ type: "open-tool", kind }),
    [],
  )
  const activateTab = React.useCallback(
    (id: SessionToolKind) => dispatch({ type: "activate-tab", id }),
    [],
  )
  const closeTab = React.useCallback(
    (id: SessionToolKind) => dispatch({ type: "close-tab", id }),
    [],
  )

  return React.useMemo(
    () => ({
      ...state,
      toggleSidebar,
      collapseSidebar,
      toggleExpanded,
      openTool,
      activateTab,
      closeTab,
    }),
    [
      activateTab,
      closeTab,
      collapseSidebar,
      openTool,
      state,
      toggleExpanded,
      toggleSidebar,
    ],
  )
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

type SessionToolSidebarProps = {
  controller: SessionToolSidebarController
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
  controller,
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
  const tabButtonRefs = React.useRef(new Map<SessionToolKind, HTMLButtonElement>())
  const newTabButtonRef = React.useRef<HTMLButtonElement | null>(null)
  const launcherButtonRef = React.useRef<HTMLButtonElement | null>(null)
  const [terminalTabBarTarget, setTerminalTabBarTarget] = React.useState<HTMLElement | null>(null)
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
    if (!controller.open) return
    const frame = window.requestAnimationFrame(() => {
      if (controller.activeTabId) {
        tabButtonRefs.current.get(controller.activeTabId)?.focus()
      } else {
        launcherButtonRef.current?.focus()
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [controller.activeTabId, controller.open])

  if (width === 0 || typeof document === "undefined") return null

  const panelStyle: React.CSSProperties = controller.expanded
    ? { left: hostLeft, width: hostWidth, transform: "translateX(0)" }
    : {
        left: hostLeft + hostWidth - width,
        width,
        transform: controller.open ? "translateX(0)" : "translateX(100%)",
      }

  const focusTab = (id: SessionToolKind) => {
    controller.activateTab(id)
    window.requestAnimationFrame(() => tabButtonRefs.current.get(id)?.focus())
  }

  const closeTabAndRestoreFocus = (id: SessionToolKind) => {
    const closedIndex = controller.tabs.findIndex((tab) => tab.id === id)
    const remainingTabs = controller.tabs.filter((tab) => tab.id !== id)
    const nextTabId = controller.activeTabId === id
      ? remainingTabs[Math.min(closedIndex, remainingTabs.length - 1)]?.id ?? null
      : controller.activeTabId

    controller.closeTab(id)
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
    if ((event.target as HTMLElement).closest("[data-terminal-tabs]")) return
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
      aria-hidden={!controller.open}
      inert={!controller.open ? true : undefined}
      className={cn(
        "fixed inset-y-0 z-40 flex min-w-0 flex-col overflow-hidden border-l border-border bg-background text-foreground",
        controller.open ? "pointer-events-auto" : "pointer-events-none",
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
            const label = t(meta.labelKey)

            if (tab.kind === "terminal" && active) {
              return (
                <div
                  key={tab.id}
                  id={`session-tool-tab-${tab.id}`}
                  ref={setTerminalTabBarTarget}
                  className="aa-window-no-drag aa-term-tabs-shell min-w-0 flex-1 basis-0 overflow-hidden"
                />
              )
            }

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
                  id={`session-tool-tab-${tab.id}`}
                  role="tab"
                  variant="ghost"
                  size="sm"
                  aria-selected={active}
                  aria-controls={`session-tool-panel-${tab.id}`}
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
                  onClick={() => closeTabAndRestoreFocus(tab.id)}
                  className="mr-0.5 rounded-lg hover:bg-transparent"
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
            return (
              <section
                key={tab.id}
                id={`session-tool-panel-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`session-tool-tab-${tab.id}`}
                aria-hidden={!active}
                className={cn(
                  "absolute inset-0 min-h-0 overflow-hidden",
                  active ? "visible pointer-events-auto" : "invisible pointer-events-none",
                )}
              >
                {tab.kind === "review" ? <ReviewPlaceholder /> : null}
                {tab.kind === "terminal" ? (
                  <TerminalPanelBody
                    token={token}
                    connectorId={connectorId}
                    root={root}
                    variant="tab"
                    tabBarTarget={active ? terminalTabBarTarget : null}
                  />
                ) : null}
                {tab.kind === "files" ? (
                  <FilesPanelBody
                    token={token}
                    connectorId={connectorId}
                    connectorDeviceOs={connectorDeviceOs}
                    root={root}
                    variant="tab"
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

function ReviewPlaceholder() {
  const t = useTranslations("dashboard.session.tools")

  return (
    <Empty className="h-full rounded-xl border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileDiff />
        </EmptyMedia>
        <EmptyTitle>{t("reviewPlaceholderTitle")}</EmptyTitle>
        <EmptyDescription>{t("reviewPlaceholderDescription")}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function sessionToolSidebarReducer(
  state: SessionToolSidebarState,
  action: SessionToolSidebarAction,
): SessionToolSidebarState {
  if (action.type === "toggle-sidebar") {
    return state.open
      ? { ...state, open: false, expanded: false }
      : { ...state, open: true }
  }
  if (action.type === "collapse-sidebar") {
    return { ...state, open: false, expanded: false }
  }
  if (action.type === "toggle-expanded") {
    return { ...state, expanded: !state.expanded }
  }
  if (action.type === "open-tool") {
    const exists = state.tabs.some((tab) => tab.kind === action.kind)
    return {
      ...state,
      open: true,
      tabs: exists ? state.tabs : [...state.tabs, { id: action.kind, kind: action.kind }],
      activeTabId: action.kind,
    }
  }
  if (action.type === "activate-tab") {
    if (!state.tabs.some((tab) => tab.id === action.id)) return state
    return { ...state, activeTabId: action.id }
  }
  if (action.type === "close-tab") {
    const closedIndex = state.tabs.findIndex((tab) => tab.id === action.id)
    if (closedIndex === -1) return state
    const tabs = state.tabs.filter((tab) => tab.id !== action.id)
    const activeTabId = state.activeTabId === action.id
      ? tabs[Math.min(closedIndex, tabs.length - 1)]?.id ?? null
      : state.activeTabId
    return { ...state, tabs, activeTabId }
  }
  return state
}
