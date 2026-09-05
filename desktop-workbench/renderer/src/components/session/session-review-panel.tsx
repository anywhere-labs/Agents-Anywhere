"use client"

import * as React from "react"
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileDiff,
  LoaderCircle,
  RotateCcw,
  SquareDot,
  SquareMinus,
  SquarePlus,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  LazyFileTree,
  sortFileTreeEntries,
} from "@/components/panels/lazy-file-tree"
import { FileTypeIcon } from "@/components/panels/file-type-icon"
import { useStoredSessionReviewTimeline } from "@/components/session-tool-sidebar-state"
import { DiffPanel } from "@/components/session/session-tool-cards"
import {
  buildLatestChangedTurnReview,
  type ChangedTurnReview,
  type ReviewFileChange,
} from "@/components/session/session-review-model"
import { isVisibleTimelineItem } from "@/components/session/session-utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { dashboardApi } from "@/features/dashboard/api"
import type { FsEntry, TimelineItem } from "@/features/dashboard/types"
import { mergeTimelineItems } from "@/components/session/optimistic-timeline"
import { openNativeFilePreviewWindow } from "@/lib/file-preview-window"
import { cn } from "@/lib/utils"

const REVIEW_HISTORY_PAGE_SIZE = 500

type ReviewHistoryState = {
  items: TimelineItem[]
  hasMore: boolean | null
  error: string | null
}

type ReviewTree = {
  entries: FsEntry[]
  childrenByPath: Map<string, FsEntry[]>
  expandedPaths: string[]
  actionByPath: Map<string, ReviewFileChange["action"]>
  orderedFilePaths: string[]
}

export function SessionReviewPanel({
  sessionId,
  token,
  connectorId,
  root,
  connectorDeviceOs,
  active,
}: {
  sessionId: string
  token: string | null
  connectorId: string | null
  root: string
  connectorDeviceOs?: string | null
  active: boolean
}) {
  const t = useTranslations("dashboard.session.tools")
  const timeline = useStoredSessionReviewTimeline(sessionId)
  const [history, setHistory] = React.useState<ReviewHistoryState>({
    items: [],
    hasMore: null,
    error: null,
  })
  const [loadingHistory, setLoadingHistory] = React.useState(false)
  const loadingHistoryRef = React.useRef(false)
  const requestGenerationRef = React.useRef(0)
  const caseInsensitivePaths = connectorDeviceOs === "windows"

  React.useEffect(() => {
    requestGenerationRef.current += 1
    loadingHistoryRef.current = false
    setLoadingHistory(false)
    setHistory({ items: [], hasMore: null, error: null })
  }, [sessionId])

  const allItems = React.useMemo(() => {
    if (!timeline) return history.items
    return mergeTimelineItems(history.items, timeline.items)
  }, [history.items, timeline])
  const visibleItems = React.useMemo(
    () => allItems.filter(isVisibleTimelineItem),
    [allItems],
  )
  const review = React.useMemo(
    () => buildLatestChangedTurnReview(visibleItems, { root, caseInsensitivePaths }),
    [caseInsensitivePaths, root, visibleItems],
  )
  const historyHasMore = history.hasMore ?? timeline?.hasMore ?? false
  const needsOlderTimeline = historyHasMore && (!review || review.key === "prelude")
  const needsOlderTimelineRef = React.useRef(needsOlderTimeline)
  needsOlderTimelineRef.current = needsOlderTimeline

  React.useEffect(() => () => {
    requestGenerationRef.current += 1
    loadingHistoryRef.current = false
  }, [])

  const loadOlderTimeline = React.useCallback(async () => {
    if (!active || !token || !timeline || loadingHistoryRef.current || !needsOlderTimeline) return
    const oldestItem = allItems[0]
    if (!oldestItem) return

    const generation = requestGenerationRef.current
    loadingHistoryRef.current = true
    setLoadingHistory(true)
    try {
      const older = await dashboardApi.getSessionTimelineBefore(
        token,
        sessionId,
        oldestItem.orderSeq,
        REVIEW_HISTORY_PAGE_SIZE,
      )
      if (generation !== requestGenerationRef.current) return
      const madeProgress = older.items.some((item) => item.orderSeq < oldestItem.orderSeq)
      setHistory((current) => ({
        items: mergeTimelineItems(older.items, current.items),
        hasMore: older.hasMore && madeProgress,
        error: null,
      }))
    } catch (error) {
      if (generation !== requestGenerationRef.current || !needsOlderTimelineRef.current) return
      setHistory((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      if (generation === requestGenerationRef.current) {
        loadingHistoryRef.current = false
        setLoadingHistory(false)
      }
    }
  }, [active, allItems, needsOlderTimeline, sessionId, timeline, token])

  React.useEffect(() => {
    if (history.error) return
    void loadOlderTimeline()
  }, [history.error, loadOlderTimeline])

  if (!timeline) return <ReviewPanelSkeleton />

  if (!review) {
    if (loadingHistory || needsOlderTimeline) return <ReviewPanelSkeleton />
    return (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileDiff />
          </EmptyMedia>
          <EmptyTitle>{t("reviewEmptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("reviewEmptyDescription")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="relative h-full min-h-0">
      {history.error ? (
        <div className="absolute inset-x-3 top-3 z-20 flex items-center gap-2 rounded-xl border border-destructive/30 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm backdrop-blur">
          <span className="min-w-0 flex-1 truncate" title={history.error}>
            {t("reviewHistoryFailed")}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0"
            onClick={() => {
              setHistory((current) => ({ ...current, error: null }))
            }}
          >
            <RotateCcw />
            {t("reviewRetry")}
          </Button>
        </div>
      ) : null}
      <ReviewWorkspace
        review={review}
        token={token}
        connectorId={connectorId}
        root={root}
        caseInsensitivePaths={caseInsensitivePaths}
        loadingHistory={loadingHistory}
      />
    </div>
  )
}

function ReviewWorkspace({
  review,
  token,
  connectorId,
  root,
  caseInsensitivePaths,
  loadingHistory,
}: {
  review: ChangedTurnReview
  token: string | null
  connectorId: string | null
  root: string
  caseInsensitivePaths: boolean
  loadingHistory: boolean
}) {
  const t = useTranslations("dashboard.session.tools")
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [collapsedPaths, setCollapsedPaths] = React.useState<Set<string>>(() => new Set())
  const fileRefs = React.useRef(new Map<string, HTMLElement>())
  const reviewTree = React.useMemo(
    () => buildReviewTree(review, root, caseInsensitivePaths),
    [caseInsensitivePaths, review, root],
  )
  const orderedFiles = React.useMemo(() => {
    const fileByPath = new Map(review.files.map((file) => [file.path, file]))
    return reviewTree.orderedFilePaths.flatMap((path) => {
      const file = fileByPath.get(path)
      return file ? [file] : []
    })
  }, [review.files, reviewTree.orderedFilePaths])
  const treeIdentity = React.useMemo(
    () => `${review.key}:${reviewTree.orderedFilePaths.join("\n")}`,
    [review.key, reviewTree.orderedFilePaths],
  )

  React.useEffect(() => {
    setSelectedPath((current) => (
      current && orderedFiles.some((file) => file.path === current)
        ? current
        : orderedFiles[0]?.path ?? null
    ))
  }, [orderedFiles, review.key])

  React.useEffect(() => {
    setCollapsedPaths(new Set())
  }, [review.key])

  const loadDirectory = React.useCallback(async (path: string) => ({
    path,
    entries: reviewTree.childrenByPath.get(path) ?? [],
    truncated: false,
  }), [reviewTree.childrenByPath])

  const setFileOpen = React.useCallback((path: string, open: boolean) => {
    setCollapsedPaths((current) => {
      if (open === !current.has(path)) return current
      const next = new Set(current)
      if (open) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const selectFile = React.useCallback((path: string) => {
    setFileOpen(path, true)
    setSelectedPath(path)
    window.requestAnimationFrame(() => {
      fileRefs.current.get(path)?.scrollIntoView({ block: "start" })
    })
  }, [setFileOpen])

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full min-h-0">
      <ResizablePanel id="review-diffs" defaultSize="64%" minSize="180px">
        <ScrollArea className="h-full min-w-0">
          <TooltipProvider delayDuration={350}>
            <div className="min-w-0 divide-y divide-border pb-8">
              {orderedFiles.map((file) => (
                <ReviewFileSection
                  key={`${review.key}:${file.path}`}
                  file={file}
                  token={token}
                  connectorId={connectorId}
                  root={root}
                  selected={selectedPath === file.path}
                  open={!collapsedPaths.has(file.path)}
                  sectionRef={(element) => {
                    if (element) fileRefs.current.set(file.path, element)
                    else fileRefs.current.delete(file.path)
                  }}
                  onSelect={() => setSelectedPath(file.path)}
                  onOpenChange={(open) => setFileOpen(file.path, open)}
                />
              ))}
            </div>
          </TooltipProvider>
        </ScrollArea>
      </ResizablePanel>

      <ResizableHandle title={t("reviewResizeTree")} aria-label={t("reviewResizeTree")} />

      <ResizablePanel
        id="review-tree"
        defaultSize="36%"
        minSize="140px"
        maxSize="55%"
        groupResizeBehavior="preserve-pixel-size"
      >
        <aside className="relative h-full min-h-0" aria-label={t("reviewFileTree")}>
          {loadingHistory ? (
            <LoaderCircle className="absolute right-3 top-3 z-10 size-3.5 animate-spin text-muted-foreground" />
          ) : null}
          <ScrollArea className="h-full min-w-0">
            <LazyFileTree
              identity={treeIdentity}
              rootPath={`review:${review.key}`}
              entries={reviewTree.entries}
              ariaLabel={t("reviewFileTree")}
              canLoad
              caseInsensitivePaths={caseInsensitivePaths}
              selectedPath={selectedPath}
              initialExpandedPaths={reviewTree.expandedPaths}
              labels={{
                empty: t("reviewEmptyTitle"),
                loading: t("reviewTreeLoading"),
                noConnector: t("reviewEmptyTitle"),
                retry: t("reviewRetry"),
                truncated: t("reviewTreeTruncated"),
              }}
              loadDirectory={loadDirectory}
              onOpenFile={(entry) => selectFile(entry.path)}
              renderTrailing={(entry) => (
                <ReviewTreeStatus
                  entry={entry}
                  action={reviewTree.actionByPath.get(entry.path)}
                />
              )}
            />
          </ScrollArea>
        </aside>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function ReviewFileSection({
  file,
  token,
  connectorId,
  root,
  selected,
  open,
  sectionRef,
  onSelect,
  onOpenChange,
}: {
  file: ReviewFileChange
  token: string | null
  connectorId: string | null
  root: string
  selected: boolean
  open: boolean
  sectionRef: (element: HTMLElement | null) => void
  onSelect: () => void
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("dashboard.session.tools")

  const openFilePreview = React.useCallback(() => {
    onSelect()
    openNativeFilePreviewWindow({
      token,
      connectorId,
      root,
      file: { name: file.name, path: file.path },
      onBlocked: () => toast.error(t("reviewPreviewBlocked")),
    })
  }, [connectorId, file.name, file.path, onSelect, root, t, token])

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <section
        ref={sectionRef}
        data-review-file-path={file.path}
        className="min-w-0 scroll-mt-0"
      >
        <header
          className={cn(
            "sticky top-0 z-10 flex h-11 min-w-0 items-center border-b border-border bg-background/95 shadow-sm backdrop-blur",
            (open || selected) && "bg-muted/80",
          )}
        >
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              aria-label={t(open ? "reviewCollapseFile" : "reviewExpandFile", {
                file: file.displayPath,
              })}
              className="h-full min-w-0 flex-1 justify-start gap-2 rounded-none px-3 font-normal hover:bg-muted/50 aria-expanded:bg-transparent aria-expanded:text-inherit"
              onClick={onSelect}
            >
              <FileTypeIcon name={file.name} className="size-[18px] shrink-0" />
              <ReviewFilePath file={file} />
              <div className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
              </div>
              {open ? <ChevronDown /> : <ChevronRight />}
            </Button>
          </CollapsibleTrigger>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("reviewOpenFilePreview", { file: file.displayPath })}
                className="mr-2 rounded-lg"
                onClick={openFilePreview}
              >
                <ExternalLink />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" sideOffset={6}>
              {t("reviewOpenFilePreview", { file: file.displayPath })}
            </TooltipContent>
          </Tooltip>
        </header>

        <CollapsibleContent>
          <div className="flex min-w-0 flex-col gap-3 bg-muted/20 p-3">
            {file.diffs.length > 0 ? (
              file.diffs.map((diff, index) => (
                <Card
                  key={diff.id}
                  size="sm"
                  role="group"
                  aria-label={t("reviewDiffCard", {
                    index: index + 1,
                    count: file.diffs.length,
                  })}
                  className="gap-0 rounded-lg bg-background py-0 shadow-sm ring-1 ring-border/80"
                >
                  <CardContent className="p-0">
                    <DiffPanel
                      code={diff.diff}
                      maxHeight={diffPanelHeight(diff.diff)}
                      compactGutter
                    />
                  </CardContent>
                </Card>
              ))
            ) : (
              <Card
                size="sm"
                className="gap-0 rounded-lg bg-background py-0 shadow-sm ring-1 ring-border/80"
              >
                <CardContent className="px-3 py-5 text-xs text-muted-foreground">
                  {t("reviewDiffUnavailable")}
                </CardContent>
              </Card>
            )}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

function ReviewFilePath({ file }: { file: ReviewFileChange }) {
  const slashIndex = file.displayPath.lastIndexOf("/")
  const prefix = slashIndex >= 0 ? file.displayPath.slice(0, slashIndex + 1) : ""
  const name = slashIndex >= 0 ? file.displayPath.slice(slashIndex + 1) : file.displayPath

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={file.displayPath}
          className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap text-sm"
        >
          {prefix ? (
            <span className="min-w-0 overflow-hidden whitespace-nowrap text-muted-foreground [direction:rtl]">
              <span className="[direction:ltr]">{prefix}</span>
            </span>
          ) : null}
          <span className="shrink-0 font-medium text-foreground">{name}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" sideOffset={6} className="max-w-lg font-mono break-all">
        {file.path}
      </TooltipContent>
    </Tooltip>
  )
}

function ReviewTreeStatus({
  entry,
  action,
}: {
  entry: FsEntry
  action: ReviewFileChange["action"] | undefined
}) {
  const t = useTranslations("dashboard.session.tools")
  if (entry.type === "directory") {
    return (
      <span
        role="img"
        aria-label={t("reviewFolderChanged")}
        title={t("reviewFolderChanged")}
        className="size-2 rounded-full bg-amber-500 ring-2 ring-background"
      />
    )
  }
  if (action === "add") {
    return <SquarePlus aria-label={t("reviewFileAdded")} className="size-4 text-emerald-500" />
  }
  if (action === "delete") {
    return <SquareMinus aria-label={t("reviewFileDeleted")} className="size-4 text-red-500" />
  }
  return <SquareDot aria-label={t("reviewFileModified")} className="size-4 text-orange-500" />
}

function ReviewPanelSkeleton() {
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(140px,36%)] divide-x divide-border" aria-busy="true">
      <div className="flex min-w-0 flex-col gap-5 p-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex min-w-0 flex-col gap-2">
            <Skeleton className="h-8 w-full rounded-lg" />
            <Skeleton className={cn("w-full rounded-lg", index === 1 ? "h-44" : "h-28")} />
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-2 p-3">
        {["w-4/5", "ml-3 w-3/4", "ml-6 w-2/3", "ml-3 w-3/5"].map((width) => (
          <Skeleton key={width} className={cn("h-7 rounded-lg", width)} />
        ))}
      </div>
    </div>
  )
}

function buildReviewTree(
  review: ChangedTurnReview,
  root: string,
  caseInsensitivePaths: boolean,
): ReviewTree {
  const childrenByPath = new Map<string, FsEntry[]>()
  const actionByPath = new Map<string, ReviewFileChange["action"]>()
  const directoryByKey = new Map<string, FsEntry>()
  const expandedPaths: string[] = []
  const treeRootPath = `review:${review.key}:root`
  const rootEntry: FsEntry = {
    name: reviewRootName(root),
    path: treeRootPath,
    type: "directory",
  }
  childrenByPath.set(treeRootPath, [])
  expandedPaths.push(treeRootPath)

  for (const file of review.files) {
    const segments = file.displayPath.split("/").filter(Boolean)
    const fileName = segments.pop() || file.name
    let parentPath = treeRootPath
    let segmentKey = ""

    for (const segment of segments) {
      const identitySegment = caseInsensitivePaths ? segment.toLocaleLowerCase() : segment
      segmentKey = `${segmentKey}/${identitySegment}`
      let entry = directoryByKey.get(segmentKey)
      if (!entry) {
        const directoryPath = `${treeRootPath}:directory:${segmentKey}`
        entry = { name: segment, path: directoryPath, type: "directory" }
        directoryByKey.set(segmentKey, entry)
        appendTreeEntry(childrenByPath, parentPath, entry)
        childrenByPath.set(directoryPath, [])
        expandedPaths.push(directoryPath)
      }
      parentPath = entry.path
    }

    const fileEntry: FsEntry = { name: fileName, path: file.path, type: "file" }
    appendTreeEntry(childrenByPath, parentPath, fileEntry)
    actionByPath.set(file.path, file.action)
  }

  const orderedFilePaths: string[] = []
  const appendOrderedFiles = (parentPath: string) => {
    const entries = sortFileTreeEntries(
      childrenByPath.get(parentPath) ?? [],
      caseInsensitivePaths,
    )
    for (const entry of entries) {
      if (entry.type === "directory") appendOrderedFiles(entry.path)
      else orderedFilePaths.push(entry.path)
    }
  }
  appendOrderedFiles(treeRootPath)

  return {
    entries: [rootEntry],
    childrenByPath,
    expandedPaths,
    actionByPath,
    orderedFilePaths,
  }
}

function appendTreeEntry(childrenByPath: Map<string, FsEntry[]>, parentPath: string, entry: FsEntry) {
  const siblings = childrenByPath.get(parentPath) ?? []
  if (siblings.some((sibling) => sibling.path === entry.path)) return
  childrenByPath.set(parentPath, [...siblings, entry])
}

function reviewRootName(root: string) {
  const normalized = root.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  if (!normalized || normalized === ".") return "."
  return normalized.split("/").at(-1) || normalized
}

function diffPanelHeight(diff: string) {
  const lineCount = Math.max(1, diff.split("\n").length)
  return Math.max(76, Math.min(520, lineCount * 21 + 16))
}
