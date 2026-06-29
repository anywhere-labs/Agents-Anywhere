"use client"

import * as React from "react"
import { Download, FolderTree, Loader2, PanelLeft, SquareTerminal } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { useSidebar } from "@/components/ui/sidebar"
import { useDashboardSidebarControls } from "@/components/demo"
import { useWorkspace, type PanelId } from "@/components/workspace-context"
import type { SessionMemorySnapshot } from "@/components/session-detail"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"
import type { SessionView as SessionViewModel } from "@/lib/demo-api"

const PANEL_META: Record<PanelId, { titleKey: "panelFiles" | "panelShell"; icon: typeof FolderTree }> = {
  files: { titleKey: "panelFiles", icon: FolderTree },
  terminal: { titleKey: "panelShell", icon: SquareTerminal },
}

const HEADER_BLUR_LAYERS = buildBlurGradientLayers({
  height: 56,
  layerCount: 9,
  maxBlur: 12,
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
}

export function SessionViewHeader({
  session,
  connectorName,
  memorySnapshot,
  onExportMemoryTimeline,
  onExportRemoteTimeline,
  exporting,
}: SessionViewHeaderProps) {
  const { isMobile, toggleSidebar } = useSidebar()
  const sidebarControls = useDashboardSidebarControls()
  const tActions = useTranslations("dashboard.actions")
  const toggleDashboardSidebar = React.useCallback(() => {
    if (isMobile) {
      toggleSidebar()
      return
    }
    sidebarControls?.toggleSidebar()
  }, [isMobile, sidebarControls, toggleSidebar])

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-10 h-14 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-background/80 to-background/0" />
      {HEADER_BLUR_LAYERS.map((layer) => (
        <div key={layer.key} className={layer.className} style={layer.style} />
      ))}
      <div className="pointer-events-auto relative flex h-14 items-center gap-2 px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={sidebarControls?.open === false ? tActions("expand") : tActions("collapse")}
          onClick={toggleDashboardSidebar}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <PanelLeft className="size-4" />
        </Button>
        <h1 className="truncate text-sm font-medium">{session.title}</h1>
        <SessionMetaBadge
          session={session}
          connectorName={connectorName}
          memorySnapshot={memorySnapshot}
          onExportMemoryTimeline={onExportMemoryTimeline}
          onExportRemoteTimeline={onExportRemoteTimeline}
          exporting={exporting}
        />
        <div className="ml-auto flex items-center gap-1">
          <TogglePanelButton id="files" icon={FolderTree} />
          <TogglePanelButton id="terminal" icon={SquareTerminal} />
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
  const label = `${connectorName ?? session.connectorId}/${session.runtime}`
  const timelineSummary = memorySnapshot
    ? t("timelineSummary", { count: memorySnapshot.items.length, seq: memorySnapshot.nextSeq })
    : t("memoryLoading")
  const approvalsSummary = memorySnapshot
    ? t("approvalsPending", { count: memorySnapshot.pendingApprovalCount })
    : t("memoryLoading")
  const rows = [
    [t("device"), connectorName ?? session.connectorId],
    [t("runtime"), session.runtime],
    [t("status"), `${memorySnapshot?.session.status ?? session.status} · ${session.connectorStatus}`],
    [t("workspace"), memorySnapshot?.session.cwd ?? session.cwd ?? t("none")],
    [t("sessionId"), session.id],
    [t("externalId"), memorySnapshot?.session.externalSessionId ?? t("none")],
    [t("timeline"), timelineSummary],
    [t("approvals"), approvalsSummary],
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
