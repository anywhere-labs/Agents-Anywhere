"use client"

import * as React from "react"
import { useCompactPanel } from "@/hooks/use-compact-panel"
import { useDiscardFileChanges } from "@/components/discard-file-changes-dialog"
import type { PanelImperativeHandle } from "react-resizable-panels"
import {
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  File,
  Folder,
  FolderOpen,
  ListTree,
  MessageSquarePlus,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { FilePathBreadcrumb, FilePreviewSurface } from "@/components/file-preview-page"
import { LazyFileTree } from "@/components/panels/lazy-file-tree"
import { filePathBreadcrumbParent } from "@/lib/file-path-breadcrumb"
import { FileBreadcrumbPicker } from "@/components/panels/file-breadcrumb-picker"
import type { SessionFilePreviewTarget, OpenSessionFilePreview } from "@/components/session/session-file-preview-context"
import {
  findSessionFileTargetEntry,
  resolveSessionFilePath,
  resolveSessionFileTargetMetadata,
  sessionFileListRepresentsDirectory,
  sessionFileNameFromPath,
  sessionFileParentPath,
  sessionFilePathNeedsCanonicalHome,
  sessionFileTreeAllowed,
} from "@/components/session/session-file-preview-model"
import { useWorkspace } from "@/components/workspace-context"
import { dashboardApi } from "@/features/dashboard/api"
import type { FsEntry } from "@/features/dashboard/types"
import { copyText } from "@/lib/clipboard"
import { downloadBlob } from "@/lib/download"
import { openNativeFilePreviewWindow } from "@/lib/file-preview-window"
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
  initialFile?: SessionFilePreviewTarget | null
  onDirtyChange?: (dirty: boolean) => void
  onOpenFilePreview?: OpenSessionFilePreview
  onKeepFileOpen?: () => void
  onSelectedFileNameChange?: (name: string | null) => void
  previewContent?: React.ReactNode
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
  initialFile,
  onSelectedFileNameChange,
  onDirtyChange,
  onOpenFilePreview,
  onKeepFileOpen,
  previewContent,
}: FilesPanelBodyProps) {
  const { ref: panelRef, compact } = useCompactPanel()
  const t = useTranslations("dashboard.panels.files")
  const { appendPathToComposer } = useWorkspace()
  const tokenRef = React.useRef(token)
  tokenRef.current = token
  const effectiveRoot = root?.trim() || "."
  const treeAllowed = sessionFileTreeAllowed(initialFile)
  const [path, setPath] = React.useState(".")
  const [currentPath, setCurrentPath] = React.useState(".")
  const currentPathRef = React.useRef(currentPath)
  currentPathRef.current = currentPath
  const [entries, setEntries] = React.useState<FsEntry[]>([])
  const [entriesTruncated, setEntriesTruncated] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [contextEntry, setContextEntry] = React.useState<FsEntry | null>(null)
  const [selectedFile, setSelectedFile] = React.useState<SessionFilePreviewTarget | null>(
    initialFile ?? null,
  )
  const [panelTitle, setPanelTitle] = React.useState<string | null>(initialFile?.name ?? null)
  const [treeOpen, setTreeOpen] = React.useState(treeAllowed)
  const [treeResizeActive, setTreeResizeActive] = React.useState(false)
  const loadRequestIdRef = React.useRef(0)
  const expandedTreePathsRef = React.useRef<readonly string[]>(initialFile?.browseExpandedPaths ?? [])
  const handleExpandedPathsChange = React.useCallback((paths: string[]) => {
    expandedTreePathsRef.current = paths
  }, [])
  const directoryContextRef = React.useRef<string | null>(null)
  const directoryContext = `${connectorId}:${effectiveRoot}:${connectorDeviceOs ?? ""}`
  const treePanelRef = React.useRef<PanelImperativeHandle | null>(null)
  const treeViewportRef = React.useRef<HTMLDivElement | null>(null)

  const { confirmDiscard, discardDialog } = useDiscardFileChanges()
  const dirtyRef = React.useRef(false)
  const handleDirtyChange = React.useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
    onDirtyChange?.(dirty)
  }, [onDirtyChange])

  const canLoad = Boolean(token && connectorId)
  const isWindowsConnector = connectorDeviceOs === "windows"

  React.useEffect(() => {
    onSelectedFileNameChange?.(panelTitle)
  }, [onSelectedFileNameChange, panelTitle])

  const toggleTree = React.useCallback(() => {
    const panel = treePanelRef.current
    if (!panel) return
    if (panel.isCollapsed()) {
      panel.expand()
    } else {
      panel.collapse()
    }
    setTreeOpen(!panel.isCollapsed())
  }, [])

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
        directoryContextRef.current = directoryContext
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
    [connectorId, directoryContext, effectiveRoot, isWindowsConnector, token],
  )

  React.useEffect(() => {
    const token = tokenRef.current
    if (initialFile?.source === "workspace" && initialFile.browsePath !== undefined && canLoad) {
      setSelectedFile(initialFile)
      setPanelTitle(initialFile.name)
      // File-tree selections already have canonical paths. Preserve the loaded tree,
      // its expanded branches, and the split layout while changing only the preview.
      if (directoryContextRef.current !== directoryContext || currentPathRef.current !== initialFile.browsePath) {
        void loadDir(initialFile.browsePath)
      }
      else {
        loadRequestIdRef.current += 1
        setLoading(false)
        setError(null)
      }
      return
    }
    const requestId = ++loadRequestIdRef.current
    const initialPath = effectiveRoot
    setPath(initialPath)
    setCurrentPath(initialPath)
    setEntries([])
    setEntriesTruncated(false)
    setError(null)
    setContextEntry(null)
    setPanelTitle(initialFile?.name ?? null)
    setTreeOpen(treeAllowed)

    if (!treeAllowed) {
      setSelectedFile(initialFile ?? null)
      setLoading(false)
      return
    }

    setSelectedFile(initialFile ?? null)
    if (!token || !connectorId || !canLoad) {
      setSelectedFile(initialFile ?? null)
      setLoading(false)
      return
    }

    const initialize = async () => {
      setLoading(true)
      try {
        if (!initialFile) {
          const response = await dashboardApi.connectorFsList(token, connectorId, {
            root: effectiveRoot,
            path: initialPath,
          })
          if (requestId !== loadRequestIdRef.current) return
          const resolvedPath = response.result.path || initialPath
          setPath(resolvedPath)
          setCurrentPath(resolvedPath)
          setEntries(response.result.entries)
          directoryContextRef.current = directoryContext
          setEntriesTruncated(Boolean(response.result.truncated))
          return
        }

        const targetResponse = await dashboardApi.connectorFsList(token, connectorId, {
          root: effectiveRoot,
          path: initialFile.path,
        })
        if (requestId !== loadRequestIdRef.current) return

        directoryContextRef.current = directoryContext
        const targetMetadata = resolveSessionFileTargetMetadata(
          targetResponse.result,
          isWindowsConnector,
        )
        if (targetMetadata) {
          const browsePath = targetMetadata.browsePath || effectiveRoot
          setPath(browsePath)
          setCurrentPath(browsePath)
          setEntries(targetResponse.result.entries)
          setEntriesTruncated(Boolean(targetResponse.result.truncated))

          if (targetMetadata.kind === "directory") {
            setSelectedFile(null)
            setPanelTitle(initialFile.name || sessionFileNameFromPath(browsePath))
            return
          }

          const resolvedName = targetMetadata.kind === "file"
            ? targetMetadata.entry?.name || sessionFileNameFromPath(targetMetadata.targetPath)
            : initialFile.name || sessionFileNameFromPath(targetMetadata.targetPath)
          setSelectedFile({
            ...initialFile,
            name: resolvedName,
            path: targetMetadata.targetPath,
          })
          setPanelTitle(resolvedName)
          return
        }

        // Older Connectors do not report the original target before fs.readDir
        // falls back to a parent directory. Canonicalize the workspace/Home roots
        // so common symlinked roots (for example macOS /tmp) still resolve safely.
        const needsCanonicalHome = sessionFilePathNeedsCanonicalHome(initialFile.path)
        const [rootResponse, homeResponse] = await Promise.all([
          dashboardApi.connectorFsList(token, connectorId, {
            root: effectiveRoot,
            path: ".",
          }),
          needsCanonicalHome && initialFile.path.trim() !== "~"
            ? dashboardApi.connectorFsList(token, connectorId, {
                root: effectiveRoot,
                path: "~",
              })
            : Promise.resolve(null),
        ])
        if (requestId !== loadRequestIdRef.current) return

        const canonicalRoot = rootResponse.result.path || effectiveRoot
        const listedPath = targetResponse.result.path || canonicalRoot
        const canonicalHome = needsCanonicalHome
          ? homeResponse?.result.path || canonicalRoot
          : ""
        if (sessionFileListRepresentsDirectory(
          listedPath,
          canonicalRoot,
          initialFile.path,
          isWindowsConnector,
          canonicalHome,
        )) {
          setPath(listedPath)
          setCurrentPath(listedPath)
          setEntries(targetResponse.result.entries)
          setEntriesTruncated(Boolean(targetResponse.result.truncated))
          setSelectedFile(null)
          setPanelTitle(initialFile.name || sessionFileNameFromPath(listedPath))
          return
        }

        setPath(listedPath)
        setCurrentPath(listedPath)
        setEntries(targetResponse.result.entries)
        setEntriesTruncated(Boolean(targetResponse.result.truncated))

        const targetEntry = findSessionFileTargetEntry(
          targetResponse.result.entries,
          canonicalRoot,
          initialFile.path,
          isWindowsConnector,
          canonicalHome,
        )
        if (targetEntry && (targetEntry.type === "file" || targetEntry.type === "symlink")) {
          setSelectedFile({
            ...initialFile,
            name: targetEntry.name,
            path: targetEntry.path,
          })
          setPanelTitle(targetEntry.name)
          return
        }

        setSelectedFile({
          ...initialFile,
          path: resolveSessionFilePath(
            canonicalRoot,
            initialFile.path,
            isWindowsConnector,
            canonicalHome,
          ),
        })
      } catch (err) {
        if (requestId !== loadRequestIdRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setSelectedFile(initialFile ?? null)
      } finally {
        if (requestId === loadRequestIdRef.current) setLoading(false)
      }
    }

    void initialize()
  }, [canLoad, connectorId, directoryContext, effectiveRoot, initialFile, isWindowsConnector, loadDir, treeAllowed])

  const parentPath = React.useMemo(
    () => sessionFileParentPath(currentPath || path),
    [currentPath, path],
  )
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

  const openEntry = async (entry: FsEntry, keepOpen = false, fromBreadcrumb = false) => {
    if (variant === "tab" && entry.path === selectedFile?.path) {
      if (keepOpen) onKeepFileOpen?.()
      return
    }
    if (variant === "tab" && onOpenFilePreview && (entry.type === "file" || entry.type === "symlink")) {
      const normalize = (value: string) => {
        const path = value.replaceAll("\\", "/").replace(/\/+$/, "")
        return isWindowsConnector ? path.toLowerCase() : path
      }
      // Breadcrumbs can select a file outside the tree's current browsing root.
      const withinTree = normalize(entry.path).startsWith(`${normalize(currentPath)}/`)
      onOpenFilePreview({
        source: "workspace", name: entry.name, path: entry.path, root: effectiveRoot,
        browsePath: withinTree ? currentPath : filePathBreadcrumbParent(entry.path),
        browseExpandedPaths: withinTree ? [...expandedTreePathsRef.current] : [],
        browseScroll: withinTree && !fromBreadcrumb && treeViewportRef.current ? {
          top: treeViewportRef.current.scrollTop,
          left: treeViewportRef.current.scrollLeft,
        } : undefined,
      }, { preview: !keepOpen })
      return
    }
    if (entry.path !== selectedFile?.path && dirtyRef.current && !await confirmDiscard()) return
    if (entry.type === "directory") {
      void loadDir(entry.path)
      return
    }
    if (entry.type === "file" || entry.type === "symlink") {
      const file: SessionFilePreviewTarget = {
        source: "workspace",
        name: entry.name,
        path: entry.path,
        root: effectiveRoot,
      }
      if (variant === "tab") {
        handleDirtyChange(false)
        setSelectedFile(file)
        if (compact) { treePanelRef.current?.collapse(); setTreeOpen(false) }
        setPanelTitle(file.name)
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
          <ScrollArea className="aa-fs-browser" viewportRef={treeViewportRef}>
            <LazyFileTree
              identity={`${connectorId ?? ""}:${effectiveRoot}:${connectorDeviceOs ?? ""}:${currentPath}`}
              // An empty Windows path is the all-drives root, not a missing path.
              rootPath={currentPath}
              entries={sortedEntries}
              rootLoading={loading}
              rootError={error}
              rootTruncated={entriesTruncated}
              canLoad={canLoad}
              caseInsensitivePaths={isWindowsConnector}
              selectedPath={selectedFile?.path}
              revealSelectedPath
              initialExpandedPaths={initialFile?.browseExpandedPaths}
              restoredExpandedPaths={initialFile?.browseExpandedPaths}
              restoredScroll={initialFile?.browseScroll}
              scrollViewportRef={treeViewportRef}
              onExpandedPathsChange={handleExpandedPathsChange}
              labels={{
                empty: t("empty"),
                loading: t("loading"),
                noConnector: t("noConnector"),
                retry: t("retry"),
                truncated: t("truncated"),
              }}
              loadDirectory={loadTreeDirectory}
              onOpenFile={openEntry}
              onKeepFileOpen={onOpenFilePreview ? (entry) => void openEntry(entry, true) : undefined}
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
    const breadcrumbPath = treeAllowed
      ? selectedFile?.path || (isWindowsConnector && currentPath === "" ? t("allDrives") : currentPath)
      : selectedFile?.name || initialFile?.name || "."
    const previewPane = (
      <section className="aa-fs-preview" aria-label={t("preview")}>
        {selectedFile ? previewContent ?? (
          <FilePreviewSurface
            key={`${connectorId}:${effectiveRoot}:${selectedFile.source}:${selectedFile.sourceUrl ?? ""}`}
            token={token ?? null}
            connectorId={connectorId ?? ""}
            root={effectiveRoot}
            initialPath={selectedFile.path}
            initialName={selectedFile.name}
            sourceUrl={selectedFile.sourceUrl}
            sourceMediaType={selectedFile.mediaType}
            sourceSize={selectedFile.size}
            readOnly={selectedFile.source === "attachment"}
            onDirtyChange={handleDirtyChange}
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
              <EmptyMedia>
                <FolderOpen />
              </EmptyMedia>
              <EmptyTitle>{t("openFile")}</EmptyTitle>
              <EmptyDescription>{t("openFileDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    )

    return (
      <Card ref={panelRef} size="sm" className="aa-rt-pane aa-rt-pane-tab">
        {discardDialog}
        <CardContent className="aa-rt-content">
          <header className="aa-fs-shared-header">
            <FilePathBreadcrumb
              path={breadcrumbPath}
              renderSegment={treeAllowed && canLoad ? (segment, current) => (
                <FileBreadcrumbPicker
                  key={`${connectorId}:${effectiveRoot}:${segment.path}`}
                  {...segment}
                  current={current}
                  directory={!current || !selectedFile}
                  caseInsensitivePaths={isWindowsConnector}
                  loadDirectory={loadTreeDirectory}
                  onSelect={(entry) => void openEntry(entry, false, true)}
                  onBrowse={onKeepFileOpen}
                />
              ) : undefined}
            />
            {treeAllowed && selectedFile ? (
              <TooltipProvider delayDuration={500}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="aa-fs-tree-toggle shrink-0"
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      aria-label={treeOpen ? t("hideTree") : t("showTree")}
                      aria-expanded={treeOpen}
                      data-open={treeOpen ? "true" : "false"}
                      onClick={toggleTree}
                    >
                      <ListTree />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="end" sideOffset={6}>
                    {treeOpen ? t("hideTree") : t("showTree")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </header>
          {treeAllowed ? (
            <ResizablePanelGroup
              direction={compact ? "vertical" : "horizontal"}
              className={cn("aa-fs-workspace", treeResizeActive && "is-resizing")}
            >
              {selectedFile ? <ResizablePanel id="files-preview" defaultSize="60%" minSize="35%">
                {previewPane}
              </ResizablePanel> : null}

              {selectedFile ? <ResizableHandle
                className={cn("aa-fs-tree-resize-handle", !treeOpen && "hidden")}
                title={t("resizeTree")}
                aria-label={t("resizeTree")}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  setTreeResizeActive(true)
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                  setTreeResizeActive(false)
                }}
                onPointerCancel={() => setTreeResizeActive(false)}
                onLostPointerCapture={() => setTreeResizeActive(false)}
              /> : null}

              <ResizablePanel
                id="files-tree"
                panelRef={treePanelRef}
                collapsible={Boolean(selectedFile)}
                collapsedSize="0px"
                defaultSize={selectedFile ? "40%" : "100%"}
                minSize={compact ? "20%" : "160px"}
                maxSize={selectedFile ? "65%" : "100%"}
                groupResizeBehavior="preserve-pixel-size"
                onResize={(size) => {
                  const collapsed = treePanelRef.current?.isCollapsed() ?? size.inPixels <= 1
                  setTreeOpen(!collapsed)
                }}
              >
                <aside className={cn("aa-fs-tree", !treeOpen && "collapsed")} aria-label={t("fileTree")} inert={!treeOpen || undefined} aria-hidden={!treeOpen}>
                  {fileTreeBrowser}
                </aside>
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="aa-fs-workspace">{previewPane}</div>
          )}
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
