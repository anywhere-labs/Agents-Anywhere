"use client"

import * as React from "react"
import { ChevronRight, ChevronUp, Copy, Download, File, Folder, FolderOpen, MessageSquarePlus, RefreshCw, X } from "lucide-react"
import { toast } from "sonner"

import "./runtime-panel.css"
import { ChevronExternal } from "./runtime-icons"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { useWorkspace } from "@/components/workspace-context"
import { dashboardApi } from "@/features/dashboard/api"
import type { FsEntry } from "@/features/dashboard/types"
import { localeFromPathname, readStoredLocale } from "@/i18n/client-locale"
import { copyText } from "@/lib/clipboard"
import { downloadBlob } from "@/lib/download"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

export type PickedFile = {
  name: string
  path: string
}

type FilesPanelBodyProps = {
  token?: string | null
  connectorId?: string | null
  root?: string | null
  onClose?: () => void
  onPopOut?: () => void
  onPopupBlocked?: () => void
}

export function FilesPanelBody({
  token,
  connectorId,
  root,
  onClose,
  onPopOut,
  onPopupBlocked,
}: FilesPanelBodyProps) {
  const t = useTranslations("dashboard.panels.files")
  const { appendPathToComposer } = useWorkspace()
  const effectiveRoot = root?.trim() || "."
  const [path, setPath] = React.useState(".")
  const [currentPath, setCurrentPath] = React.useState(".")
  const [entries, setEntries] = React.useState<FsEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [contextEntry, setContextEntry] = React.useState<FsEntry | null>(null)

  const canLoad = Boolean(token && connectorId)

  const loadDir = React.useCallback(
    async (nextPath: string) => {
      if (!token || !connectorId) return
      const target = nextPath.trim() || "."
      setLoading(true)
      setError(null)
      try {
        const response = await dashboardApi.connectorFsList(token, connectorId, {
          root: effectiveRoot,
          path: target,
        })
        const resolvedPath = response.result.path || target
        setEntries(response.result.entries)
        setCurrentPath(resolvedPath)
        setPath(resolvedPath)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [connectorId, effectiveRoot, token],
  )

  React.useEffect(() => {
    setPath(".")
    setCurrentPath(".")
    setEntries([])
    setError(null)
    if (canLoad) void loadDir(".")
  }, [canLoad, connectorId, effectiveRoot, loadDir])

  const parentPath = React.useMemo(() => parentOf(currentPath || path), [currentPath, path])
  const sortedEntries = React.useMemo(
    () =>
      entries.slice().sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1
        if (a.type !== "directory" && b.type === "directory") return 1
        return a.name.localeCompare(b.name)
      }),
    [entries],
  )
  const entriesByPath = React.useMemo(() => new Map(sortedEntries.map((entry) => [entry.path, entry])), [sortedEntries])
  const contextPath = contextEntry?.path ?? currentPath
  const contextIsFile = contextEntry ? isDownloadableEntry(contextEntry) : false

  const openEntry = (entry: FsEntry) => {
    if (entry.type === "directory") {
      void loadDir(entry.path)
      return
    }
    if (entry.type === "file" || entry.type === "symlink") {
      const file = { name: entry.name, path: entry.path }
      openNativeFilePreviewWindow({
        token,
        connectorId,
        root: effectiveRoot,
        file,
        onBlocked: onPopupBlocked,
        labels: {
          preview: t("preview"),
          loading: t("previewLoading", { name: file.name }),
          noConnector: t("noConnector"),
          binaryUnavailable: (size) => t("binaryUnavailable", { size }),
          truncated: t("truncated"),
        },
      })
    }
  }

  const copyPath = async () => {
    try {
      await copyText(contextPath)
      toast.success(t("pathCopied"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("copyPathFailed"))
    }
  }

  const addToComposer = () => {
    if (!appendPathToComposer(contextPath)) {
      toast.error(t("addToComposerNoSession"))
      return
    }
    toast.success(t("pathAddedToComposer"))
  }

  const downloadEntry = async () => {
    if (!token || !connectorId || !contextEntry || !contextIsFile) return
    try {
      const response = await dashboardApi.connectorFsRead(token, connectorId, effectiveRoot, contextEntry.path)
      const blob = await dashboardApi.downloadBlob(token, response.result.downloadUrl)
      downloadBlob(blob, response.result.name || contextEntry.name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("downloadFailed"))
    }
  }

  const updateContextTarget = (event: React.MouseEvent) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>("[data-fs-entry-path]")
      : null
    const entryPath = target?.dataset.fsEntryPath
    setContextEntry(entryPath ? entriesByPath.get(entryPath) ?? null : null)
  }

  return (
    <Card size="sm" className="aa-rt-pane">
      <CardHeader className="aa-rt-hd">
        <CardTitle className="aa-rt-title">
          <FolderOpen className="size-3.5" />
          {t("title")}
        </CardTitle>
        <Separator orientation="vertical" className="aa-rt-sep" />
        <div className="aa-rt-acts">
          <Button
            className="aa-rt-iconbtn"
            variant="ghost"
            size="icon-sm"
            type="button"
            title={t("goParent")}
            aria-label={t("goParent")}
            onClick={() => parentPath && void loadDir(parentPath)}
            disabled={loading || !parentPath || !canLoad}
          >
            <ChevronUp className="size-3.5" />
          </Button>
          <Button
            className="aa-rt-iconbtn"
            variant="ghost"
            size="icon-sm"
            type="button"
            title={t("refresh")}
            aria-label={t("refresh")}
            onClick={() => void loadDir(path)}
            disabled={loading || !canLoad}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
          {onPopOut ? (
            <Button
              className="aa-rt-iconbtn"
              variant="ghost"
              size="icon-sm"
              type="button"
              title={t("openWindow")}
              aria-label={t("openWindow")}
              onClick={onPopOut}
            >
              <ChevronExternal />
            </Button>
          ) : null}
          {onClose ? (
            <Button
              className="aa-rt-iconbtn"
              variant="ghost"
              size="icon-sm"
              type="button"
              title={t("close")}
              aria-label={t("close")}
              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="aa-rt-content">
        <div className="aa-fs-pathbar">
          <div className="aa-fs-path-field">
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadDir(path)
              }}
              aria-label={t("directoryPath")}
              disabled={!canLoad}
            />
          </div>
          <Button
            className="aa-rt-iconbtn"
            variant="ghost"
            size="icon-sm"
            type="button"
            title={t("openPath")}
            aria-label={t("openPath")}
            onClick={() => void loadDir(path)}
            disabled={loading || !path.trim() || !canLoad}
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </div>

        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex min-h-0 flex-1 flex-col" onContextMenu={updateContextTarget}>
              <ScrollArea className="aa-fs-browser">
                <div className="aa-fs-browser-inner">
                  {!canLoad ? <div className="aa-rt-empty">{t("noConnector")}</div> : null}
                  {error ? <div className="aa-rt-error">{error}</div> : null}
                  {loading && entries.length === 0 ? <div className="aa-rt-empty">{t("loading")}</div> : null}
                  {!loading && !error && canLoad && entries.length === 0 ? <div className="aa-rt-empty">{t("empty")}</div> : null}
                  {canLoad && parentPath ? (
                    <button className="aa-fs-row" type="button" onClick={() => void loadDir(parentPath)}>
                      <FolderOpen className="size-3.5" />
                      <span>..</span>
                      <em>{t("parent")}</em>
                    </button>
                  ) : null}
                  {sortedEntries.map((entry) => (
                    <button
                      key={entry.path}
                      className="aa-fs-row"
                      type="button"
                      data-fs-entry-path={entry.path}
                      onClick={() => openEntry(entry)}
                      disabled={entry.type !== "directory" && entry.type !== "file" && entry.type !== "symlink"}
                    >
                      {entry.type === "directory" ? <Folder className="size-3.5" /> : <File className="size-3.5" />}
                      <span>{entry.name}</span>
                      <em>{entry.type === "file" && typeof entry.size === "number" ? formatBytes(entry.size) : entry.type}</em>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onSelect={() => void copyPath()}>
              <Copy className="size-4" />
              {t("copyPath")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={addToComposer}>
              <MessageSquarePlus className="size-4" />
              {t("addToComposer")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void downloadEntry()} disabled={!contextIsFile || !canLoad}>
              <Download className="size-4" />
              {t("download")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </CardContent>
    </Card>
  )
}

export function openNativeFilePreviewWindow({
  connectorId,
  root,
  file,
  onBlocked,
}: {
  token?: string | null
  connectorId?: string | null
  root: string
  file: PickedFile
  onBlocked?: () => void
  labels?: {
    preview: string
    loading: string
    noConnector: string
    binaryUnavailable: (size: string) => string
    truncated: string
  }
}) {
  const locale = previewLocale()
  const search = new URLSearchParams({
    connectorId: connectorId ?? "",
    root,
    path: file.path,
    name: file.name,
  })
  const child = window.open(`/${locale}#/preview?${search.toString()}`, "_blank", "width=980,height=720,resizable=yes,scrollbars=yes")
  if (!child) {
    onBlocked?.()
    return
  }
  child.focus()
}

function previewLocale() {
  return localeFromPathname(window.location.pathname) ?? readStoredLocale() ?? "en"
}

function parentOf(rawPath: string): string {
  const clean = normalizeWindowsDrivePath(rawPath).trim().replace(/[/\\]+$/, "") || "."
  if (clean === "." || clean === "/" || /^[A-Za-z]:[\\/]?$/.test(clean)) return ""
  const normalized = clean.replace(/\\/g, "/")
  const slash = normalized.lastIndexOf("/")
  if (slash < 0) return "."
  if (slash === 0) return "/"
  return normalized.slice(0, slash)
}

function normalizeWindowsDrivePath(path: string): string {
  return path.replace(/^\/([A-Za-z]:[\\/])/, "$1")
}

function isDownloadableEntry(entry: FsEntry) {
  return entry.type === "file" || entry.type === "symlink"
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
