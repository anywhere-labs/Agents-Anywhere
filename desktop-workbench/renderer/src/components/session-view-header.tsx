"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { Download, FolderOpen, Loader2, PanelRight } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { useWorkspace } from "@/components/workspace-context"
import { useIsMobile } from "@/hooks/use-mobile"
import type { SessionMemorySnapshot } from "@/components/session-detail"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"
import type { SessionView as SessionViewModel } from "@/lib/demo-api"
import { runtimeLabel } from "@/components/session/session-utils"
import { sessionRuntimeType } from "@/features/dashboard/runtime-instances"

const HEADER_BLUR_LAYERS = buildBlurGradientLayers({
  height: 56,
  layerCount: 9,
  maxBlur: 10,
  minBlur: 0,
  overlap: 8,
  gamma: 1.85,
})

type BlurLayerStyle = React.CSSProperties & {
  WebkitBackdropFilter?: string
  WebkitMaskImage?: string
}

type SessionViewHeaderProps = {
  session: SessionViewModel
  connectorName?: string | null
  memorySnapshot: SessionMemorySnapshot | null
  onExportMemoryTimeline?: () => void
  onExportRemoteTimeline?: () => void
  exporting?: boolean
  toolsOpen: boolean
  toolsExpanded: boolean
  toolsOverlayWidth: number
  onToggleTools: () => void
}

export function SessionViewHeader({
  session,
  connectorName,
  memorySnapshot,
  onExportMemoryTimeline,
  onExportRemoteTimeline,
  exporting,
  toolsOpen,
  toolsExpanded,
  toolsOverlayWidth,
  onToggleTools,
}: SessionViewHeaderProps) {
  const { renameSession } = useWorkspace()
  const tSession = useTranslations("dashboard.session")
  const isMobile = useIsMobile()
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState(session.title ?? "")
  const [renaming, setRenaming] = React.useState(false)
  const [desktopPortalTargets, setDesktopPortalTargets] = React.useState<{
    session: HTMLElement
    actions: HTMLElement
  } | null>(null)

  React.useEffect(() => {
    const sessionTarget = document.querySelector<HTMLElement>(
      '[data-slot="desktop-shell-header-session"]',
    )
    const actionsTarget = document.querySelector<HTMLElement>(
      '[data-slot="desktop-shell-header-session-actions"]',
    )
    if (sessionTarget && actionsTarget) {
      setDesktopPortalTargets({ session: sessionTarget, actions: actionsTarget })
    }
  }, [])

  React.useEffect(() => {
    if (!editingTitle) setTitleDraft(session.title ?? "")
  }, [editingTitle, session.title])

  const cancelRename = React.useCallback(() => {
    setTitleDraft(session.title ?? "")
    setEditingTitle(false)
  }, [session.title])

  const submitRename = React.useCallback(async () => {
    const nextTitle = titleDraft.trim()
    if (!nextTitle) {
      cancelRename()
      return
    }
    if (renaming) return
    if (nextTitle === session.title) {
      setEditingTitle(false)
      return
    }
    setRenaming(true)
    try {
      const ok = await renameSession(session.id, nextTitle)
      if (ok) setEditingTitle(false)
      else toast.error(tSession("renameFailed"))
    } finally {
      setRenaming(false)
    }
  }, [cancelRename, renameSession, renaming, session.id, session.title, tSession, titleDraft])

  const metaBadge = (
    <SessionMetaBadge
      session={session}
      connectorName={connectorName}
      memorySnapshot={memorySnapshot}
      onExportMemoryTimeline={onExportMemoryTimeline}
      onExportRemoteTimeline={onExportRemoteTimeline}
      exporting={exporting}
    />
  )

  if (!isMobile) {
    if (!desktopPortalTargets) return null

    return (
      <>
        {toolsExpanded ? null : createPortal(
          <div
            className="flex w-full min-w-0 items-center gap-2 overflow-hidden"
            style={{ paddingRight: toolsOverlayWidth }}
          >
            {editingTitle ? (
              <Input
                autoFocus
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.currentTarget.value)}
                onBlur={cancelRename}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === "Enter") {
                    event.preventDefault()
                    void submitRename()
                  }
                  if (event.key === "Escape") {
                    event.preventDefault()
                    cancelRename()
                  }
                }}
                disabled={renaming}
                aria-label={tSession("renameTitle")}
                className="h-7 w-64 min-w-0 max-w-[28vw] rounded-lg text-sm"
              />
            ) : (
              <button
                type="button"
                className="min-w-0 max-w-64 truncate rounded-md px-1 text-left text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={tSession("renameTitle")}
                title={session.title ?? tSession("renameTitle")}
                onClick={() => {
                  setTitleDraft(session.title ?? "")
                  setEditingTitle(true)
                }}
              >
                {session.title}
              </button>
            )}
            {metaBadge}
          </div>,
          desktopPortalTargets.session,
        )}
        {toolsOpen ? null : createPortal(
          <TooltipProvider delayDuration={800}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={tSession(toolsOpen ? "tools.collapse" : "tools.toggle")}
                  aria-pressed={toolsOpen}
                  onClick={onToggleTools}
                  data-slot="session-tool-sidebar-toggle"
                  className={cn(
                    "rounded-md text-muted-foreground/70 hover:bg-muted hover:text-foreground",
                    toolsOpen && "bg-muted text-foreground",
                  )}
                >
                  <PanelRight />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end" sideOffset={6}>
                {tSession("tools.visibilityToggle")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>,
          desktopPortalTargets.actions,
        )}
      </>
    )
  }

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-10 h-14 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-background/80 to-background/0" />
      {HEADER_BLUR_LAYERS.map((layer) => (
        <div key={layer.key} className={layer.className} style={layer.style} />
      ))}
      <div className="pointer-events-auto relative flex h-14 items-center gap-2 px-2">
        <DashboardSidebarToggle />
        {editingTitle ? (
          <Input
            autoFocus
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.currentTarget.value)}
            onBlur={cancelRename}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === "Enter") {
                event.preventDefault()
                void submitRename()
              }
              if (event.key === "Escape") {
                event.preventDefault()
                cancelRename()
              }
            }}
            disabled={renaming}
            aria-label={tSession("renameTitle")}
            className="h-8 min-w-0 max-w-[min(28rem,40vw)] flex-1 rounded-xl text-sm"
          />
        ) : (
          <button
            type="button"
            className="min-w-0 truncate rounded-md px-1 text-left text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={tSession("renameTitle")}
            onClick={() => {
              setTitleDraft(session.title ?? "")
              setEditingTitle(true)
            }}
          >
            {session.title}
          </button>
        )}
        {metaBadge}
        <div className="ml-auto flex items-center gap-1">
          <MobileFilesButton />
        </div>
      </div>
    </header>
  )
}

function buildBlurGradientLayers({
  height,
  layerCount,
  maxBlur,
  minBlur,
  overlap,
  gamma,
}: {
  height: number
  layerCount: number
  maxBlur: number
  minBlur: number
  overlap: number
  gamma: number
}) {
  const step = height / layerCount
  return Array.from({ length: layerCount }, (_, index) => {
    const start = Math.max(0, Math.round(index * step - overlap * 0.5))
    const end = Math.min(height, Math.round((index + 1) * step + overlap))
    const progress = index / Math.max(1, layerCount - 1)
    const blur = minBlur + (maxBlur - minBlur) * Math.pow(1 - progress, gamma)
    const fadeIn = index === 0 ? 0 : 26
    const fadeOut = index === layerCount - 1 ? 72 : 76
    const mask =
      index === 0
        ? `linear-gradient(to bottom, black 0%, black ${fadeOut}%, transparent 100%)`
        : `linear-gradient(to bottom, transparent 0%, black ${fadeIn}%, black ${fadeOut}%, transparent 100%)`

    return {
      key: `${index}-${start}-${end}-${blur.toFixed(2)}`,
      className: "absolute inset-x-0",
      style: {
        top: `${start}px`,
        height: `${Math.max(1, end - start)}px`,
        backdropFilter: `blur(${blur.toFixed(2)}px)`,
        WebkitBackdropFilter: `blur(${blur.toFixed(2)}px)`,
        maskImage: mask,
        WebkitMaskImage: mask,
      } satisfies BlurLayerStyle,
    }
  })
}

function SessionMetaBadge({
  session,
  connectorName,
  memorySnapshot,
  onExportMemoryTimeline,
  onExportRemoteTimeline,
  exporting,
}: {
  session: SessionViewModel
  connectorName?: string | null
  memorySnapshot: SessionMemorySnapshot | null
  onExportMemoryTimeline?: () => void
  onExportRemoteTimeline?: () => void
  exporting?: boolean
}) {
  const t = useTranslations("dashboard.session")
  const displayRuntimeType = session.runtimeTypeDisplayName?.trim()
    || runtimeLabel(sessionRuntimeType(session))
  const displayRuntime = session.runtimeName?.trim() || displayRuntimeType
  const runtimeContext = displayRuntime === displayRuntimeType
    ? displayRuntime
    : `${displayRuntime} · ${displayRuntimeType}`
  const label = `${connectorName ?? session.connectorId}/${runtimeContext}`
  const timelineSummary = memorySnapshot
    ? t("timelineSummary", { count: memorySnapshot.items.length, seq: memorySnapshot.nextSeq })
    : t("memoryLoading")
  const interactionsSummary = memorySnapshot
    ? t("interactionsPending", { count: memorySnapshot.pendingInteractionCount })
    : t("memoryLoading")
  const rows = [
    [t("device"), connectorName ?? session.connectorId],
    [t("runtime"), displayRuntime],
    [t("runtimeType"), displayRuntimeType],
    [t("status"), `${memorySnapshot?.state?.status ?? memorySnapshot?.session.status ?? session.status} · ${session.connectorStatus}`],
    [t("workspace"), memorySnapshot?.session.cwd ?? session.cwd ?? t("none")],
    [t("sessionId"), session.id],
    [t("externalId"), memorySnapshot?.session.externalSessionId ?? t("none")],
    [t("timeline"), timelineSummary],
    [t("interactions"), interactionsSummary],
  ] as const

  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={`${t("overview")}: ${label}`}
          className="max-w-[min(24rem,40vw)] min-w-0 shrink-0 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge
            variant="secondary"
            className="max-w-full cursor-default gap-1.5 font-normal"
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                session.connectorStatus === "online" ? "bg-emerald-500" : "bg-muted-foreground/40",
              )}
            />
            <span className="min-w-0 truncate">{label}</span>
          </Badge>
        </button>
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
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="font-normal"
              onClick={onExportMemoryTimeline}
              disabled={!memorySnapshot}
            >
              <Download className="size-3.5" />
              {t("exportMemoryTimelineJson")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="font-normal"
              onClick={onExportRemoteTimeline}
              disabled={exporting}
            >
              {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              {exporting ? t("exportingTimeline") : t("exportRemoteTimelineJson")}
            </Button>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

function MobileFilesButton() {
  const { panels, setPanelMode } = useWorkspace()
  const t = useTranslations("dashboard.session")
  const active = panels.files === "floating"
  return (
    <button
      type="button"
      aria-label={t("panelFiles")}
      onClick={() => setPanelMode("files", active ? "closed" : "floating")}
      className={cn(
        "rounded-md p-2 transition-colors hover:bg-accent hover:text-foreground",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <FolderOpen className="size-4" />
    </button>
  )
}
