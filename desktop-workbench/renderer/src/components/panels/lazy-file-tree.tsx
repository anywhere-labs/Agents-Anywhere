"use client"

import * as React from "react"
import { ChevronRight, LoaderCircle, RotateCcw } from "lucide-react"

import { FileTypeIcon } from "./file-type-icon"
import type { FsEntry, FsListResult } from "@/features/dashboard/types"
import { cn } from "@/lib/utils"

type DirectoryState =
  | { status: "loading"; requestId: number }
  | { status: "loaded"; requestId: number; entries: FsEntry[]; truncated: boolean }
  | { status: "error"; requestId: number; message: string }

type LazyFileTreeLabels = {
  empty: string
  loading: string
  noConnector: string
  retry: string
  truncated: string
}

type LazyFileTreeProps = {
  identity: string
  rootPath: string
  entries: FsEntry[]
  rootLoading?: boolean
  rootError?: string | null
  rootTruncated?: boolean
  canLoad: boolean
  caseInsensitivePaths?: boolean
  selectedPath?: string | null
  labels: LazyFileTreeLabels
  loadDirectory: (path: string) => Promise<FsListResult>
  onOpenFile: (entry: FsEntry) => void
  onContextEntryChange?: (entry: FsEntry | null) => void
}

type TreeStyle = React.CSSProperties & {
  "--aa-tree-guide-offset"?: string
  "--aa-tree-indent"?: string
}

const MAX_VISUAL_DEPTH = 12
const INDENT_PX = 20

export function LazyFileTree({
  identity,
  rootPath,
  entries,
  rootLoading = false,
  rootError = null,
  rootTruncated = false,
  canLoad,
  caseInsensitivePaths = false,
  selectedPath = null,
  labels,
  loadDirectory,
  onOpenFile,
  onContextEntryChange,
}: LazyFileTreeProps) {
  const treeRef = React.useRef<HTMLDivElement | null>(null)
  const branchStatesRef = React.useRef<Map<string, DirectoryState>>(new Map())
  const generationRef = React.useRef(0)
  const requestIdRef = React.useRef(0)
  const [branchStates, setBranchStates] = React.useState<Map<string, DirectoryState>>(
    () => new Map(),
  )
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(() => new Set())
  const [focusedPath, setFocusedPath] = React.useState<string | null>(null)

  const keyForPath = React.useCallback(
    (path: string) => pathIdentity(path, caseInsensitivePaths),
    [caseInsensitivePaths],
  )

  React.useEffect(() => {
    generationRef.current += 1
    branchStatesRef.current = new Map()
    setBranchStates(new Map())
    setExpandedPaths(new Set())
    setFocusedPath(null)
  }, [identity])

  React.useEffect(
    () => () => {
      generationRef.current += 1
    },
    [],
  )

  const rootEntries = React.useMemo(
    () => prepareEntries(entries, caseInsensitivePaths),
    [caseInsensitivePaths, entries],
  )
  const selectedKey = selectedPath ? keyForPath(selectedPath) : null

  const replaceBranchState = React.useCallback((key: string, state: DirectoryState) => {
    const next = new Map(branchStatesRef.current)
    next.set(key, state)
    branchStatesRef.current = next
    setBranchStates(next)
  }, [])

  const requestDirectory = React.useCallback(
    async (entry: FsEntry) => {
      const key = keyForPath(entry.path)
      if (branchStatesRef.current.get(key)?.status === "loading") return

      const requestId = ++requestIdRef.current
      const generation = generationRef.current
      replaceBranchState(key, { status: "loading", requestId })

      try {
        const result = await loadDirectory(entry.path)
        if (generation !== generationRef.current) return
        const current = branchStatesRef.current.get(key)
        if (current?.status !== "loading" || current.requestId !== requestId) return
        replaceBranchState(key, {
          status: "loaded",
          requestId,
          entries: prepareEntries(result.entries, caseInsensitivePaths),
          truncated: Boolean(result.truncated),
        })
      } catch (error) {
        if (generation !== generationRef.current) return
        const current = branchStatesRef.current.get(key)
        if (current?.status !== "loading" || current.requestId !== requestId) return
        replaceBranchState(key, {
          status: "error",
          requestId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [caseInsensitivePaths, keyForPath, loadDirectory, replaceBranchState],
  )

  const toggleDirectory = React.useCallback(
    (entry: FsEntry) => {
      const key = keyForPath(entry.path)
      const isExpanded = expandedPaths.has(key)
      setExpandedPaths((current) => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })

      if (!isExpanded) {
        const state = branchStatesRef.current.get(key)
        if (!state || state.status === "error") void requestDirectory(entry)
      }
    },
    [expandedPaths, keyForPath, requestDirectory],
  )

  const visibleTreeItems = React.useCallback(
    () =>
      Array.from(
        treeRef.current?.querySelectorAll<HTMLElement>("[data-aa-file-tree-item='true']") ?? [],
      ),
    [],
  )

  const focusTreeItem = React.useCallback((item: HTMLElement | undefined) => {
    if (!item) return
    const key = item.dataset.treeKey
    if (!key) return
    setFocusedPath(key)
    item.focus()
  }, [])

  React.useEffect(() => {
    const items = visibleTreeItems()
    if (items.length === 0) {
      if (focusedPath !== null) setFocusedPath(null)
      return
    }
    if (!focusedPath || !items.some((item) => item.dataset.treeKey === focusedPath)) {
      setFocusedPath(items[0]?.dataset.treeKey ?? null)
    }
  }, [branchStates, expandedPaths, focusedPath, rootEntries, visibleTreeItems])

  const handleItemKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const current = event.currentTarget
      const items = visibleTreeItems()
      const index = items.indexOf(current)
      if (index < 0) return

      if (event.key === "ArrowDown") {
        event.preventDefault()
        focusTreeItem(items[index + 1] ?? items[index])
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        focusTreeItem(items[index - 1] ?? items[index])
        return
      }
      if (event.key === "Home") {
        event.preventDefault()
        focusTreeItem(items[0])
        return
      }
      if (event.key === "End") {
        event.preventDefault()
        focusTreeItem(items.at(-1))
        return
      }
      if (event.key === "ArrowRight" && current.dataset.treeKind === "directory") {
        event.preventDefault()
        if (current.getAttribute("aria-expanded") !== "true") {
          current.click()
          return
        }
        const currentKey = current.dataset.treeKey
        focusTreeItem(items.slice(index + 1).find((item) => item.dataset.treeParentKey === currentKey))
        return
      }
      if (event.key === "ArrowLeft") {
        const currentKey = current.dataset.treeKey
        const parentKey = current.dataset.treeParentKey
        if (current.dataset.treeKind === "directory" && current.getAttribute("aria-expanded") === "true") {
          event.preventDefault()
          current.click()
          return
        }
        if (parentKey && parentKey !== currentKey) {
          event.preventDefault()
          focusTreeItem(items.find((item) => item.dataset.treeKey === parentKey))
        }
        return
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        current.click()
      }
    },
    [focusTreeItem, visibleTreeItems],
  )

  const renderEntries = (
    siblings: FsEntry[],
    depth: number,
    parentKey: string,
    ancestorKeys: ReadonlySet<string>,
  ): React.ReactNode =>
    siblings.map((entry, index) => {
      const key = keyForPath(entry.path)
      const isDirectory = entry.type === "directory"
      const isFile = entry.type === "file" || entry.type === "symlink"
      const isCycle = isDirectory && ancestorKeys.has(key)
      const isExpanded = isDirectory && !isCycle && expandedPaths.has(key)
      const branch = branchStates.get(key)
      const rowStyle = treeIndentStyle(depth)
      const nextAncestorKeys = new Set(ancestorKeys)
      nextAncestorKeys.add(key)

      return (
        <React.Fragment key={key}>
          <button
            type="button"
            role="treeitem"
            aria-busy={isDirectory && branch?.status === "loading" ? true : undefined}
            aria-disabled={!isDirectory && !isFile ? true : isCycle || undefined}
            aria-expanded={isDirectory && !isCycle ? isExpanded : undefined}
            aria-level={depth + 1}
            aria-posinset={index + 1}
            aria-selected={isFile ? selectedKey === key : undefined}
            aria-setsize={siblings.length}
            className={cn("aa-file-tree-row", selectedKey === key && "active")}
            data-aa-file-tree-item="true"
            data-disabled={isCycle || (!isDirectory && !isFile) ? "true" : undefined}
            data-fs-entry-path={entry.path}
            data-tree-key={key}
            data-tree-kind={isDirectory ? "directory" : "file"}
            data-tree-parent-key={parentKey}
            style={rowStyle}
            tabIndex={focusedPath === key ? 0 : -1}
            title={entry.name}
            onClick={() => {
              setFocusedPath(key)
              if (isDirectory && !isCycle) toggleDirectory(entry)
              else if (isFile) onOpenFile(entry)
            }}
            onContextMenu={() => onContextEntryChange?.(entry)}
            onFocus={() => setFocusedPath(key)}
            onKeyDown={handleItemKeyDown}
          >
            <span className="aa-file-tree-leading" aria-hidden="true">
              {isDirectory ? (
                branch?.status === "loading" && isExpanded ? (
                  <LoaderCircle className="aa-file-tree-spinner" />
                ) : (
                  <ChevronRight className={cn("aa-file-tree-chevron", isExpanded && "expanded")} />
                )
              ) : (
                <FileTypeIcon name={entry.name} />
              )}
            </span>
            <span className="aa-file-tree-name">{entry.name}</span>
          </button>

          {isExpanded ? (
            <div
              role="group"
              className="aa-file-tree-group"
              style={treeGuideStyle(depth)}
            >
              {!branch || branch.status === "loading" ? (
                <TreeStatus depth={depth + 1} label={labels.loading} />
              ) : null}
              {branch?.status === "error" ? (
                <button
                  type="button"
                  className="aa-file-tree-status aa-file-tree-retry"
                  style={treeIndentStyle(depth + 1)}
                  title={branch.message}
                  onClick={() => void requestDirectory(entry)}
                >
                  <RotateCcw aria-hidden="true" />
                  <span>{labels.retry}</span>
                </button>
              ) : null}
              {branch?.status === "loaded"
                ? renderEntries(branch.entries, depth + 1, key, nextAncestorKeys)
                : null}
              {branch?.status === "loaded" && branch.truncated ? (
                <TreeStatus depth={depth + 1} label={labels.truncated} />
              ) : null}
            </div>
          ) : null}
        </React.Fragment>
      )
    })

  const rootKey = keyForPath(rootPath)

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-busy={rootLoading}
      className="aa-file-tree"
      onContextMenu={(event) => {
        const target = event.target instanceof HTMLElement
          ? event.target.closest("[data-aa-file-tree-item='true']")
          : null
        if (!target) onContextEntryChange?.(null)
      }}
    >
      {!canLoad ? <div className="aa-rt-empty">{labels.noConnector}</div> : null}
      {rootError ? <div className="aa-rt-error">{rootError}</div> : null}
      {rootLoading && rootEntries.length === 0 ? <div className="aa-rt-empty">{labels.loading}</div> : null}
      {!rootLoading && !rootError && canLoad && rootEntries.length === 0 ? (
        <div className="aa-rt-empty">{labels.empty}</div>
      ) : null}
      {renderEntries(rootEntries, 0, rootKey, new Set([rootKey]))}
      {rootTruncated ? <TreeStatus depth={0} label={labels.truncated} /> : null}
    </div>
  )
}

function TreeStatus({ depth, label }: { depth: number; label: string }) {
  return (
    <div className="aa-file-tree-status" role="status" style={treeIndentStyle(depth)}>
      <span>{label}</span>
    </div>
  )
}

function prepareEntries(entries: FsEntry[], caseInsensitivePaths: boolean): FsEntry[] {
  const seen = new Set<string>()
  return entries
    .filter((entry) => {
      const key = pathIdentity(entry.path, caseInsensitivePaths)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => {
      if (left.type === "directory" && right.type !== "directory") return -1
      if (left.type !== "directory" && right.type === "directory") return 1
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
    })
}

function pathIdentity(rawPath: string, caseInsensitive: boolean): string {
  let normalized = rawPath.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/")
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "")
  return caseInsensitive ? normalized.toLocaleLowerCase() : normalized
}

function treeIndentStyle(depth: number): TreeStyle {
  return {
    "--aa-tree-indent": `${Math.min(depth, MAX_VISUAL_DEPTH) * INDENT_PX}px`,
  }
}

function treeGuideStyle(parentDepth: number): TreeStyle {
  return {
    "--aa-tree-guide-offset": `${Math.min(parentDepth, MAX_VISUAL_DEPTH) * INDENT_PX + 17}px`,
  }
}
