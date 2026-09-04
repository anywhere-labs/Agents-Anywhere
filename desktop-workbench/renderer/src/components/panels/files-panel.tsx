"use client"

import * as React from "react"
import {
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  File,
  Folder,
  FolderOpen,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  X,
} from "lucide-react"
import { toast } from "sonner"

import "./runtime-panel.css"
import { ChevronExternal } from "./runtime-icons"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { FilePreviewSurface } from "@/components/file-preview-page"
import { LazyFileTree } from "@/components/panels/lazy-file-tree"
import { useWorkspace } from "@/components/workspace-context"
import { dashboardApi } from "@/features/dashboard/api"
import type { FsEntry } from "@/features/dashboard/types"
import { copyText } from "@/lib/clipboard"
import { downloadBlob } from "@/lib/download"
import { openNativeFilePreviewWindow, type PickedFile } from "@/lib/file-preview-window"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

type FilesPanelBodyProps = {
  token?: string | null
  connectorId?: string | null
  root?: string | null
  connectorDeviceOs?: string | null
  variant?: "desktop" | "mobile" | "tab"
  onClose?: () => void
  onPopOut?: () => void
  onPopupBlocked?: () => void
}

export function FilesPanelBody({
  token,
  connectorId,
  root,
  connectorDeviceOs,
  variant = "desktop",
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
  const [entriesTruncated, setEntriesTruncated] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [contextEntry, setContextEntry] = React.useState<FsEntry | null>(null)
  const [selectedFile, setSelectedFile] = React.useState<PickedFile | null>(null)
  const [treeOpen, setTreeOpen] = React.useState(true)
  const loadRequestIdRef = React.useRef(0)

  const canLoad = Boolean(token && connectorId)
  const isWindowsConnector = connectorDeviceOs === "windows"

  const loadDir = React.useCallback(
    async (nextPath: string) => {
      if (!token || !connectorId) return
      const requestId = ++loadRequestIdRef.current
      const trimmedPath = nextPath.trim()
      const target = isWindowsConnector ? trimmedPath : trimmedPath || "/"
      setLoading(true)
      setError(null)
      try {
        const response = await dashboardApi.connectorFsList(token, connectorId, {
          root: effectiveRoot,
          path: target,
        })
        if (requestId !== loadRequestIdRef.current) return
        const resolvedPath = response.result.path || target
        setEntries(response.result.entries)
        setEntriesTruncated(Boolean(response.result.truncated))
        setCurrentPath(resolvedPath)
        setPath(resolvedPath)
      } catch (err) {
        if (requestId !== loadRequestIdRef.current) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (requestId === loadRequestIdRef.current) setLoading(false)
      }
    },
    [connectorId, effectiveRoot, isWindowsConnector, token],
  )

  React.useEffect(() => {
    loadRequestIdRef.current += 1
    const initialPath = isWindowsConnector ? "" : effectiveRoot
    setPath(initialPath)
    setCurrentPath(initialPath)
    setEntries([])
    setEntriesTruncated(false)
    setError(null)
    setSelectedFile(null)
    if (canLoad) void loadDir(initialPath)
  }, [canLoad, connectorId, effectiveRoot, isWindowsConnector, loadDir])

  const parentPath = React.useMemo(() => parentOf(currentPath || path), [currentPath, path])
  const canGoParent = parentPath !== "" || isWindowsDriveRoot(currentPath || path)
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

  const loadTreeDirectory = React.useCallback(
    async (directoryPath: string) => {
      if (!token || !connectorId) throw new Error(t("noConnector"))
      const response = await dashboardApi.connectorFsList(token, connectorId, {
        root: effectiveRoot,
        path: directoryPath,
      })
      return response.result
    },
    [connectorId, effectiveRoot, t, token],
  )

  const openEntry = (entry: FsEntry) => {
    if (entry.type === "directory") {
      void loadDir(entry.path)
      return
    }
    if (entry.type === "file" || entry.type === "symlink") {
      const file = { name: entry.name, path: entry.path }
      if (variant === "tab") {
        setSelectedFile(file)
        return
      }
      openNativeFilePreviewWindow({
        token,
        connectorId,
        root: effectiveRoot,
        file,
        onBlocked: onPopupBlocked,
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

  const renderContextMenu = () => (
    <ContextMenuContent className="w-52">
      <ContextMenuGroup>
        <ContextMenuItem onSelect={() => void copyPath()}>
          <Copy />
          {t("copyPath")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={addToComposer}>
          <MessageSquarePlus />
          {t("addToComposer")}
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem onSelect={() => void downloadEntry()} disabled={!contextIsFile || !canLoad}>
          <Download />
          {t("download")}
        </ContextMenuItem>
      </ContextMenuGroup>
    </ContextMenuContent>
  )

  const fileBrowser = (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex min-h-0 flex-1 flex-col" onContextMenu={updateContextTarget}>
          <ScrollArea className="aa-fs-browser">
            <div className="aa-fs-browser-inner">
              {!canLoad ? <div className="aa-rt-empty">{t("noConnector")}</div> : null}
              {error ? <div className="aa-rt-error">{error}</div> : null}
              {loading && entries.length === 0 ? <div className="aa-rt-empty">{t("loading")}</div> : null}
              {!loading && !error && canLoad && entries.length === 0 ? <div className="aa-rt-empty">{t("empty")}</div> : null}
              {canLoad && canGoParent ? (
                <button className="aa-fs-row" type="button" onClick={() => void loadDir(parentPath)}>
                  <FolderOpen className="size-3.5" />
                  <span>..</span>
                  <em>{t("parent")}</em>
                </button>
              ) : null}
              {sortedEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  data-fs-entry-path={entry.path}
                  onClick={() => openEntry(entry)}
                  disabled={entry.type !== "directory" && entry.type !== "file" && entry.type !== "symlink"}
                  aria-current={selectedFile?.path === entry.path ? "page" : undefined}
                  data-selected={selectedFile?.path === entry.path ? "true" : undefined}
                  className={cn("aa-fs-row", selectedFile?.path === entry.path && "active")}
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
      {renderContextMenu()}
    </ContextMenu>
  )

  const fileTreeBrowser = (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="aa-fs-browser">
            <LazyFileTree
              identity={`${connectorId ?? ""}:${effectiveRoot}:${connectorDeviceOs ?? ""}`}
              rootPath={currentPath || effectiveRoot}
              entries={sortedEntries}
              rootLoading={loading}
              rootError={error}
              rootTruncated={entriesTruncated}
              canLoad={canLoad}
              caseInsensitivePaths={isWindowsConnector}
              selectedPath={selectedFile?.path}
              labels={{
                empty: t("empty"),
                loading: t("loading"),
                noConnector: t("noConnector"),
                retry: t("retry"),
                truncated: t("truncated"),
              }}
              loadDirectory={loadTreeDirectory}
              onOpenFile={openEntry}
              onContextEntryChange={setContextEntry}
            />
          </ScrollArea>
        </div>
      </ContextMenuTrigger>
      {renderContextMenu()}
    </ContextMenu>
  )

  if (variant === "mobile") {
    return (
      <div className="aa-mobile-panel aa-mobile-files">
        <div className="aa-mobile-pathbar">
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
            disabled={loading || (!isWindowsConnector && !path.trim()) || !canLoad}
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            className="aa-rt-iconbtn"
            variant="ghost"
            size="icon-sm"
            type="button"
            title={t("goParent")}
            aria-label={t("goParent")}
            onClick={() => void loadDir(parentPath)}
            disabled={loading || !canGoParent || !canLoad}
          >
            <ChevronUp className="size-4" />
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
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
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
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
        {fileBrowser}
      </div>
    )
  }

  if (variant === "tab") {
    return (
      <Card size="sm" className="aa-rt-pane aa-rt-pane-tab">
        <CardContent className="aa-rt-content">
          <div className="aa-fs-workspace">
            <section className="aa-fs-preview" aria-label={t("preview")}>
              {selectedFile ? (
                <FilePreviewSurface
                  key={`${connectorId}:${effectiveRoot}:${selectedFile.path}`}
                  token={token ?? null}
                  connectorId={connectorId ?? ""}
                  root={effectiveRoot}
                  initialPath={selectedFile.path}
                  initialName={selectedFile.name}
                  mode="embedded"
                  onOpenExternal={() => {
                    openNativeFilePreviewWindow({
                      token,
                      connectorId,
                      root: effectiveRoot,
                      file: selectedFile,
                      onBlocked: onPopupBlocked,
                    })
                  }}
                />
              ) : (
                <Empty className="h-full rounded-none border-0">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FolderOpen />
                    </EmptyMedia>
                    <EmptyTitle>{t("openFile")}</EmptyTitle>
                    <EmptyDescription>{t("openFileDescription")}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </section>

            <aside className={cn("aa-fs-tree", !treeOpen && "collapsed")} aria-label={t("fileTree")}>
              <div className="aa-fs-tree-toolbar">
                <Button
                  className="aa-rt-iconbtn shrink-0"
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  title={treeOpen ? t("hideTree") : t("showTree")}
                  aria-label={treeOpen ? t("hideTree") : t("showTree")}
                  aria-expanded={treeOpen}
                  onClick={() => setTreeOpen((open) => !open)}
                >
                  {treeOpen ? <PanelRightClose /> : <PanelRightOpen />}
                </Button>
              </div>
              {treeOpen ? fileTreeBrowser : null}
            </aside>
          </div>
        </CardContent>
      </Card>
    )
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
            onClick={() => void loadDir(parentPath)}
            disabled={loading || !canGoParent || !canLoad}
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
            disabled={loading || (!isWindowsConnector && !path.trim()) || !canLoad}
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </div>

        {fileBrowser}
      </CardContent>
    </Card>
  )
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

function isWindowsDriveRoot(path: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(normalizeWindowsDrivePath(path).trim())
}

function isDownloadableEntry(entry: FsEntry) {
  return entry.type === "file" || entry.type === "symlink"
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
