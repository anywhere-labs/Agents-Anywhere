"use client"

import * as React from "react"
import { ExternalLink, FolderTree, SquareTerminal } from "lucide-react"
import type { Layout } from "react-resizable-panels"

import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
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
import { useWorkspace, type PanelId } from "@/components/workspace-context"
import { useTranslations } from "next-intl"

const PANEL_META: Record<PanelId, { titleKey: "panelFiles" | "panelShell"; icon: typeof FolderTree }> = {
  files: { titleKey: "panelFiles", icon: FolderTree },
  terminal: { titleKey: "panelShell", icon: SquareTerminal },
}

const VERTICAL_LAYOUT_KEY_PREFIX = "aa-session-runtime-vertical-layout"
const RUNTIME_PANEL_ID = "runtime-dock"
const CANONICAL_VERTICAL_PANEL_IDS = ["runtime-files", "runtime-terminal"]

type SessionRuntimePanelsProps = {
  token: string | null
  connectorId: string | null
  connectorDeviceOs?: string | null
  root: string
  dockedPanels: PanelId[]
}

export function SessionRuntimePanels({
  token,
  connectorId,
  connectorDeviceOs,
  root,
  dockedPanels,
}: SessionRuntimePanelsProps) {
  const dockedPanelKey = dockedPanels.join("-")
  const verticalLayoutKey = `${VERTICAL_LAYOUT_KEY_PREFIX}:files-terminal`
  const verticalPanelIds = React.useMemo(
    () => dockedPanelKey.split("-").filter(Boolean).map((id) => `runtime-${id}`),
    [dockedPanelKey],
  )
  const verticalDefaultLayout = React.useMemo(() => createEvenLayout(verticalPanelIds), [verticalPanelIds])
  const savedVerticalDefaultLayout = React.useMemo(
    () => readSavedLayout(verticalLayoutKey, verticalPanelIds, verticalDefaultLayout, CANONICAL_VERTICAL_PANEL_IDS),
    [verticalLayoutKey, verticalPanelIds, verticalDefaultLayout],
  )
  const renderRuntimePanel = useRuntimePanelRenderer({ token, connectorId, connectorDeviceOs, root })

  if (dockedPanels.length === 0) return null

  return (
    <>
      <ResizableHandle className="bg-transparent transition-colors hover:bg-border/25 focus-visible:bg-border/40" />
      <ResizablePanel id={RUNTIME_PANEL_ID} defaultSize="34%" minSize="20%">
        <ResizablePanelGroup
          key={dockedPanelKey}
          direction="vertical"
          defaultLayout={savedVerticalDefaultLayout}
          onLayoutChanged={(layout) => writeSavedLayout(verticalLayoutKey, verticalPanelIds, layout, CANONICAL_VERTICAL_PANEL_IDS)}
          className="h-full min-h-0 overflow-hidden"
        >
          {dockedPanels.map((id, index) => (
            <React.Fragment key={id}>
              {index > 0 ? (
                <ResizableHandle className="bg-transparent transition-colors hover:bg-border/25 focus-visible:bg-border/40" />
              ) : null}
              <ResizablePanel id={`runtime-${id}`} defaultSize={`${100 / dockedPanels.length}%`} minSize="15%">
                <div className="h-full min-h-0 overflow-hidden p-[5px]">{renderRuntimePanel(id)}</div>
              </ResizablePanel>
            </React.Fragment>
          ))}
        </ResizablePanelGroup>
      </ResizablePanel>
    </>
  )
}

export function FloatingRuntimePanels({
  token,
  connectorId,
  connectorDeviceOs,
  root,
  floatingPanels,
}: {
  token: string | null
  connectorId: string | null
  connectorDeviceOs?: string | null
  root: string
  floatingPanels: PanelId[]
}) {
  const { setPanelMode } = useWorkspace()
  const t = useTranslations("dashboard.session")
  const renderRuntimePanel = useRuntimePanelRenderer({ token, connectorId, connectorDeviceOs, root })

  return (
    <>
      {floatingPanels.map((id) => (
        <NativeWindow
          key={id}
          title={t(PANEL_META[id].titleKey)}
          onClose={() => setPanelMode(id, "closed")}
        >
          <div className="h-full min-h-0 p-[5px]">{renderRuntimePanel(id, { nativeWindow: true })}</div>
        </NativeWindow>
      ))}
    </>
  )
}

export function PopupBlockedDialog() {
  const { popupBlocked, dismissPopupBlocked } = useWorkspace()
  const t = useTranslations("dashboard.session")
  const tCommon = useTranslations("common")

  return (
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
  )
}

function useRuntimePanelRenderer({
  token,
  connectorId,
  connectorDeviceOs,
  root,
}: {
  token: string | null
  connectorId: string | null
  connectorDeviceOs?: string | null
  root: string
}) {
  const { setPanelMode } = useWorkspace()

  return React.useCallback((id: PanelId, options?: { nativeWindow?: boolean }) => {
    if (id === "files") {
      return (
        <FilesPanelBody
          token={token}
          connectorId={connectorId}
          connectorDeviceOs={connectorDeviceOs}
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
  }, [connectorId, root, setPanelMode, token])
}

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

export function readSavedLayout(
  key: string,
  panelIds: string[],
  fallback: Layout,
  storagePanelIds: string[] = panelIds,
): Layout {
  if (typeof window === "undefined") return fallback

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    const stored = normalizeLayout(parsed, storagePanelIds, fallback)
    const scoped: Layout = {}
    for (const id of panelIds) {
      const value = stored[id]
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
      scoped[id] = value
    }
    return scoped
  } catch {
    return fallback
  }
}

export function writeSavedLayout(
  key: string,
  panelIds: string[],
  layout: Layout,
  storagePanelIds: string[] = panelIds,
) {
  if (typeof window === "undefined") return

  const normalized = normalizeLayout(layout, panelIds, layout)
  let storageLayout: Layout = normalized
  if (storagePanelIds.length !== panelIds.length || storagePanelIds.some((id) => !panelIds.includes(id))) {
    try {
      const existing = window.localStorage.getItem(key)
      const parsed = existing ? JSON.parse(existing) : {}
      storageLayout = {
        ...(parsed && typeof parsed === "object" ? parsed as Layout : {}),
        ...normalized,
      }
      storageLayout = normalizeLayout(storageLayout, storagePanelIds, storageLayout)
    } catch {
      storageLayout = normalized
    }
  }
  const payload = JSON.stringify(storageLayout)

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => {
      try {
        window.localStorage.setItem(key, payload)
      } catch {
        // localStorage can be unavailable in private contexts. Resizing should still work.
      }
    })
    return
  }

  try {
    window.localStorage.setItem(key, payload)
  } catch {
    // localStorage can be unavailable in private contexts. Resizing should still work.
  }
}
