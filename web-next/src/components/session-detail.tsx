"use client"

import * as React from "react"
import { ArrowDown, ChevronDown, CircleAlert, Loader2 } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { dashboardApi } from "@/features/dashboard/api"
import type {
  Approval,
  ApprovalResolveStatus,
  RuntimeConfigSchema,
  SessionStateResponse,
  SessionView,
  TimelineItem,
} from "@/features/dashboard/types"
import { useTranslations } from "next-intl"
import { ApprovalCard, ApprovalHeaderNotice } from "@/components/session/session-approval-card"
import { SessionSkeleton, SessionSkeletonInline } from "@/components/session/session-skeleton"
import { TimelineEntry } from "@/components/session/session-timeline-entry"
import { isCreatedFileChange } from "@/components/session/session-tool-cards"
import { SessionComposer, type AttachedFile } from "@/components/session/session-composer"
import { recordsOf, runtimeLabel, textOf } from "@/components/session/session-utils"

type SessionDetailProps = {
  token: string
  sessionId: string
  fallbackSession: SessionView | null
  onSessionUpdated?: (session: SessionView) => void
  onMemorySnapshotUpdated?: (snapshot: SessionMemorySnapshot | null) => void
}

export type SessionMemorySnapshot = {
  session: SessionView
  items: TimelineItem[]
  approvals: Approval[]
  nextSeq: number
  hasMore: boolean
  serverTime: string
  pendingApprovalCount: number
}

type SessionEventEnvelope = Partial<SessionStateResponse> & {
  sessionId?: string
  refetch?: boolean
}

const AUTO_SCROLL_BOTTOM_DISTANCE = 180
const SCROLL_TO_BOTTOM_INTERVAL_MS = 1000
const SESSION_STATE_PAGE_LIMIT = 500
const COMPOSER_BLUR_LAYERS = buildComposerBlurLayers({
  height: 144,
  layerCount: 10,
  maxBlur: 14,
  minBlur: 0,
  overlap: 10,
  gamma: 1.8,
})

type ComposerBlurLayerStyle = React.CSSProperties & {
  WebkitBackdropFilter?: string
  WebkitMaskImage?: string
}

function buildComposerBlurLayers({
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
        ? `linear-gradient(to top, black 0%, black ${fadeOut}%, transparent 100%)`
        : `linear-gradient(to top, transparent 0%, black ${fadeIn}%, black ${fadeOut}%, transparent 100%)`

    return {
      key: `${index}-${start}-${end}-${blur.toFixed(2)}`,
      className: "absolute inset-x-0",
      style: {
        bottom: `${start}px`,
        height: `${Math.max(1, end - start)}px`,
        backdropFilter: `blur(${blur.toFixed(2)}px)`,
        WebkitBackdropFilter: `blur(${blur.toFixed(2)}px)`,
        maskImage: mask,
        WebkitMaskImage: mask,
      } satisfies ComposerBlurLayerStyle,
    }
  })
}

async function loadCompleteSessionState(token: string, sessionId: string): Promise<SessionStateResponse> {
  const firstPage = await dashboardApi.getSessionState(token, sessionId, 0, SESSION_STATE_PAGE_LIMIT)
  if (!firstPage.hasMore) return firstPage

  const items = [...firstPage.items]
  let latestPage = firstPage

  while (latestPage.hasMore) {
    const lastItem = latestPage.items.at(-1)
    if (!lastItem) break
    latestPage = await dashboardApi.getSessionState(token, sessionId, lastItem.updatedSeq, SESSION_STATE_PAGE_LIMIT)
    items.push(...latestPage.items)
  }

  return {
    ...latestPage,
    items,
    hasMore: latestPage.hasMore && latestPage.items.length > 0,
  }
}

export function SessionDetail({
  token,
  sessionId,
  fallbackSession,
  onSessionUpdated,
  onMemorySnapshotUpdated,
}: SessionDetailProps) {
  const tSession = useTranslations("dashboard.session")
  const tNew = useTranslations("dashboard.new")
  const tCommon = useTranslations("common")
  const [state, setState] = React.useState<SessionStateResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [composerError, setComposerError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const [takeoverBusy, setTakeoverBusy] = React.useState(false)
  const [resolvingApprovalId, setResolvingApprovalId] = React.useState<string | null>(null)
  const [resolvingStatus, setResolvingStatus] = React.useState<ApprovalResolveStatus | null>(null)
  const [runtimeSchema, setRuntimeSchema] = React.useState<RuntimeConfigSchema | null>(null)
  const [runtimeSettings, setRuntimeSettings] = React.useState<Record<string, unknown> | null>(null)
  const [runtimeSettingsError, setRuntimeSettingsError] = React.useState<string | null>(null)
  const [runtimeSettingsBusy, setRuntimeSettingsBusy] = React.useState(false)
  const [showScrollBottom, setShowScrollBottom] = React.useState(false)
  const [pendingTakeover, setPendingTakeover] = React.useState<boolean | null>(null)
  const timelineRef = React.useRef<HTMLDivElement | null>(null)
  const nextSeqRef = React.useRef(0)
  const autoScrollOnNextUpdateRef = React.useRef(false)
  const forceScrollOnNextUpdateRef = React.useRef(false)
  const initialScrollDoneRef = React.useRef(false)
  const lastScrollToBottomAtRef = React.useRef(0)
  const scrollToBottomTimerRef = React.useRef<number | null>(null)

  const session = state?.session ?? fallbackSession

  React.useEffect(() => {
    if (!state) {
      onMemorySnapshotUpdated?.(null)
      return
    }
    onMemorySnapshotUpdated?.({
      session: state.session,
      items: state.items,
      approvals: state.approvals,
      nextSeq: state.nextSeq,
      hasMore: state.hasMore,
      serverTime: state.serverTime,
      pendingApprovalCount: state.approvals.filter((approval) => approval.status === "pending").length,
    })
  }, [onMemorySnapshotUpdated, state])

  const distanceFromBottom = React.useCallback(() => {
    const viewport = timelineRef.current
    if (!viewport) return 0
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
  }, [])

  const updateScrollBottomState = React.useCallback(() => {
    setShowScrollBottom(distanceFromBottom() > 96)
  }, [distanceFromBottom])

  const markAutoScrollIfNearBottom = React.useCallback(() => {
    if (distanceFromBottom() <= AUTO_SCROLL_BOTTOM_DISTANCE) {
      autoScrollOnNextUpdateRef.current = true
    }
  }, [distanceFromBottom])

  const scrollToBottomThrottled = React.useCallback((behavior: ScrollBehavior = "smooth") => {
    const run = () => {
      window.requestAnimationFrame(() => {
        const viewport = timelineRef.current
        if (!viewport) return
        viewport.scrollTo({ top: viewport.scrollHeight, behavior })
        setShowScrollBottom(false)
      })
    }

    const now = Date.now()
    const remaining = SCROLL_TO_BOTTOM_INTERVAL_MS - (now - lastScrollToBottomAtRef.current)
    if (remaining <= 0) {
      if (scrollToBottomTimerRef.current !== null) {
        window.clearTimeout(scrollToBottomTimerRef.current)
        scrollToBottomTimerRef.current = null
      }
      lastScrollToBottomAtRef.current = now
      run()
      return
    }

    if (scrollToBottomTimerRef.current !== null) return
    scrollToBottomTimerRef.current = window.setTimeout(() => {
      scrollToBottomTimerRef.current = null
      lastScrollToBottomAtRef.current = Date.now()
      run()
    }, remaining)
  }, [])

  React.useEffect(() => {
    return () => {
      if (scrollToBottomTimerRef.current !== null) {
        window.clearTimeout(scrollToBottomTimerRef.current)
      }
    }
  }, [])

  const refresh = React.useCallback(async (options: { scrollToBottom?: boolean; preserveBottom?: boolean } = {}) => {
    if (options.preserveBottom ?? true) markAutoScrollIfNearBottom()
    if (options.scrollToBottom) forceScrollOnNextUpdateRef.current = true
    setError(null)
    const next = await loadCompleteSessionState(token, sessionId)
    setState(next)
    nextSeqRef.current = Math.max(nextSeqRef.current, next.nextSeq)
    onSessionUpdated?.(next.session)
  }, [markAutoScrollIfNearBottom, onSessionUpdated, sessionId, token])

  React.useEffect(() => {
    let cancelled = false
    initialScrollDoneRef.current = false
    setLoading(true)
    setState(null)
    setError(null)
    loadCompleteSessionState(token, sessionId)
      .then((next) => {
        if (cancelled) return
        setState(next)
        nextSeqRef.current = next.nextSeq
        onSessionUpdated?.(next.session)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : tSession("loadFailed"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [onSessionUpdated, sessionId, token])

  React.useEffect(() => {
    if (!session?.runtime) return
    let cancelled = false
    setRuntimeSchema(null)
    setRuntimeSettings(null)
    setRuntimeSettingsError(null)
    Promise.all([
      dashboardApi.getRuntimeConfigSchema(token, session.runtime),
      dashboardApi.getSessionRuntimeSettings(token, session.id),
    ])
      .then(([schemaResponse, settingsResponse]) => {
        if (cancelled) return
        setRuntimeSchema(schemaResponse.schema)
        setRuntimeSettings(settingsResponse.runtimeSettings ?? settingsResponse.settings ?? {})
      })
      .catch((err) => {
        if (cancelled) return
        setRuntimeSchema(null)
        setRuntimeSettings(null)
        setRuntimeSettingsError(err instanceof Error ? err.message : tSession("loadRuntimeSettingsFailed"))
      })
    return () => {
      cancelled = true
    }
  }, [session?.id, session?.runtime, token])

  React.useEffect(() => {
    let cancelled = false
    let eventSource: EventSource | null = null
    const refetch = () => {
      markAutoScrollIfNearBottom()
      loadCompleteSessionState(token, sessionId)
        .then((next) => {
          if (cancelled) return
          nextSeqRef.current = Math.max(nextSeqRef.current, next.nextSeq)
          setState(next)
          onSessionUpdated?.(next.session)
        })
        .catch(() => undefined)
    }

    try {
      eventSource = new EventSource(dashboardApi.sessionEventsUrl(token, sessionId))
      eventSource.onmessage = (event) => {
        if (cancelled || !event.data) return
        let envelope: SessionEventEnvelope | null = null
        try {
          envelope = JSON.parse(event.data) as SessionEventEnvelope
        } catch {
          return
        }
        if (!envelope || envelope.sessionId !== sessionId) return
        if (envelope.refetch) {
          refetch()
          return
        }
        markAutoScrollIfNearBottom()
        setState((current) => mergeSessionState(current, envelope))
        if (envelope.nextSeq) nextSeqRef.current = Math.max(nextSeqRef.current, envelope.nextSeq)
        if (envelope.session) onSessionUpdated?.(envelope.session)
      }
    } catch {
      eventSource = null
    }

    const intervalId = window.setInterval(() => {
      if (eventSource?.readyState === EventSource.OPEN) return
      refetch()
    }, 3000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      eventSource?.close()
    }
  }, [markAutoScrollIfNearBottom, onSessionUpdated, sessionId, token])

  const handleSend = async (content: string, attachments: AttachedFile[]) => {
    if (!session || (!content.trim() && attachments.length === 0)) return
    setSending(true)
    setComposerError(null)
    try {
      const files = attachments.map((attachment) => attachment.file)
      const upload = files.length > 0
        ? await dashboardApi.uploadSessionAttachments(token, session.id, files)
        : null
      await dashboardApi.sendSessionMessage(token, session.id, content.trim() || tNew("attachmentOnlyPrompt"), {
        attachments: upload?.attachments.map((attachment) => ({ fileId: attachment.fileId })) ?? [],
        clientMessageId: crypto.randomUUID(),
      })
      await refresh({ scrollToBottom: true })
      scrollToBottomThrottled()
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : tSession("sendFailed"))
    } finally {
      setSending(false)
    }
  }

  const handleConfirmTakeover = async () => {
    if (!session) return
    const nextTakeover = pendingTakeover ?? !session.takeover
    setTakeoverBusy(true)
    setComposerError(null)
    try {
      const result = nextTakeover
        ? await dashboardApi.enableTakeover(token, session.id)
        : await dashboardApi.disableTakeover(token, session.id)
      setState((current) => current ? { ...current, session: result.session } : current)
      onSessionUpdated?.(result.session)
      setPendingTakeover(null)
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : tSession("updateTakeoverFailed"))
    } finally {
      setTakeoverBusy(false)
    }
  }

  const handleInterrupt = async () => {
    if (!session) return
    setComposerError(null)
    try {
      await dashboardApi.interruptSession(token, session.id)
      await refresh()
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : tSession("interruptFailed"))
    }
  }

  const handleResolveApproval = async (approvalId: string, status: ApprovalResolveStatus) => {
    if (resolvingApprovalId) return
    setResolvingApprovalId(approvalId)
    setResolvingStatus(status)
    setComposerError(null)
    try {
      await dashboardApi.resolveApproval(token, approvalId, status)
      await refresh()
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : tSession("resolveApprovalFailed"))
    } finally {
      setResolvingApprovalId(null)
      setResolvingStatus(null)
    }
  }

  const handlePatchRuntimeSettings = async (patch: Record<string, unknown>) => {
    if (!session) return
    const nextSettings = { ...(runtimeSettings ?? {}), ...patch }
    setRuntimeSettings(nextSettings)
    setRuntimeSettingsBusy(true)
    setRuntimeSettingsError(null)
    try {
      const response = await dashboardApi.patchSessionRuntimeSettings(token, session.id, nextSettings)
      setRuntimeSettings(response.runtimeSettings ?? response.settings ?? nextSettings)
      await refresh()
    } catch (err) {
      setRuntimeSettingsError(err instanceof Error ? err.message : tSession("updateRuntimeSettingsFailed"))
    } finally {
      setRuntimeSettingsBusy(false)
    }
  }

  React.useLayoutEffect(() => {
    if (!initialScrollDoneRef.current && state) {
      initialScrollDoneRef.current = true
      const viewport = timelineRef.current
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight
        setShowScrollBottom(false)
      }
      return
    }
    if (forceScrollOnNextUpdateRef.current || autoScrollOnNextUpdateRef.current) {
      forceScrollOnNextUpdateRef.current = false
      autoScrollOnNextUpdateRef.current = false
      scrollToBottomThrottled()
      return
    }
    updateScrollBottomState()
  }, [scrollToBottomThrottled, session?.status, state?.approvals.length, state?.items.length, updateScrollBottomState])

  const scrollToBottom = React.useCallback(() => {
    scrollToBottomThrottled()
  }, [scrollToBottomThrottled])

  const approvals = state?.approvals ?? []
  const approvalByTarget = React.useMemo(
    () => new Map(approvals.map((approval) => [approval.targetItemId, approval])),
    [approvals],
  )
  const detachedApprovals = approvals.filter((approval) => approval.status === "pending" && !approval.targetItemId)
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending")
  const approvalTargetIds = React.useMemo(
    () => new Set(approvals.map((approval) => approval.targetItemId).filter((id): id is string => Boolean(id))),
    [approvals],
  )
  const timelineGroups = React.useMemo(
    () => groupTimelineItems(state?.items ?? [], approvalTargetIds),
    [approvalTargetIds, state?.items],
  )

  if (loading && !session) return <SessionSkeleton />

  if (error && !session) {
    return (
      <div className="mx-auto flex h-full max-w-3xl items-center justify-center px-6">
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{tSession("unavailable")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!session) return null

  const takeoverTarget = pendingTakeover ?? false

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden overscroll-none">
      {error ? (
        <Alert variant="destructive" className="mx-auto mt-4 w-[calc(100%-2rem)] max-w-3xl">
          <CircleAlert />
          <AlertTitle>{tSession("refreshFailed")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ScrollArea
          viewportRef={timelineRef}
          className="h-full"
          viewportProps={{ onScroll: updateScrollBottomState }}
        >
          <div
            className={cn(
              "mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-3 overflow-hidden px-5 pb-44 pt-20",
              pendingApprovals.length > 0 && "pt-32",
            )}
          >
            {loading && !state ? <SessionSkeletonInline /> : null}
            {state && state.items.length === 0 && detachedApprovals.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">{tSession("noActivity")}</p>
            ) : null}
            {timelineGroups.map((group) =>
              group.kind === "tool-run" ? (
                <ToolRunGroup
                  key={group.key}
                  group={group}
                  token={token}
                  session={session}
                  approvalByTarget={approvalByTarget}
                  resolvingApprovalId={resolvingApprovalId}
                  resolvingStatus={resolvingStatus}
                  onResolveApproval={handleResolveApproval}
                />
              ) : (
                <TimelineEntry
                  key={group.item.id}
                  token={token}
                  session={session}
                  item={group.item}
                  approval={approvalByTarget.get(group.item.id)}
                  resolvingApprovalId={resolvingApprovalId}
                  resolvingStatus={resolvingStatus}
                  onResolveApproval={handleResolveApproval}
                />
              ),
            )}
            {detachedApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                resolvingApprovalId={resolvingApprovalId}
                resolvingStatus={resolvingStatus}
                onResolveApproval={handleResolveApproval}
              />
            ))}
            {session.status === "running" ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span>{tSession("runtimeWorking", { runtime: runtimeLabel(session.runtime) })}</span>
              </div>
            ) : null}
          </div>
        </ScrollArea>
        {showScrollBottom ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="absolute bottom-36 left-1/2 z-10 h-8 -translate-x-1/2 gap-1.5 rounded-full border bg-background/95 px-3 shadow-lg backdrop-blur"
            onClick={scrollToBottom}
          >
            <ArrowDown className="size-3.5" />
            {tSession("bottom")}
          </Button>
        ) : null}
      </div>

      {pendingApprovals.length > 0 ? (
        <ApprovalHeaderNotice pendingApprovalCount={pendingApprovals.length} onResolveClick={scrollToBottom} />
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 overflow-hidden">
        <div className="absolute inset-x-0 bottom-0 h-36 bg-linear-to-t from-background/80 to-background/0" />
        {COMPOSER_BLUR_LAYERS.map((layer) => (
          <div key={layer.key} className={layer.className} style={layer.style} />
        ))}
        <div className="pointer-events-auto relative">
          <SessionComposer
            session={session}
            pendingApprovalCount={pendingApprovals.length}
            error={composerError}
            sending={sending}
            takeoverBusy={takeoverBusy}
            runtimeSchema={runtimeSchema}
            runtimeSettings={runtimeSettings}
            runtimeSettingsError={runtimeSettingsError}
            runtimeSettingsBusy={runtimeSettingsBusy}
            onDismissError={() => setComposerError(null)}
            onPatchRuntimeSettings={handlePatchRuntimeSettings}
            onSend={handleSend}
            onInterrupt={handleInterrupt}
            onToggleTakeover={() => setPendingTakeover(!session.takeover)}
          />
        </div>
      </div>
      <Dialog
        open={pendingTakeover !== null}
        onOpenChange={(open) => {
          if (!open && !takeoverBusy) setPendingTakeover(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {takeoverTarget ? tSession("takeoverEnableTitle") : tSession("takeoverDisableTitle")}
            </DialogTitle>
            <DialogDescription>
              {takeoverTarget ? tSession("takeoverEnableDescription") : tSession("takeoverDisableDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingTakeover(null)} disabled={takeoverBusy}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={handleConfirmTakeover} disabled={takeoverBusy}>
              {takeoverBusy ? <Loader2 className="size-4 animate-spin" /> : null}
              {takeoverTarget ? tSession("takeoverEnableConfirm") : tSession("takeoverDisableConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

type TimelineSingleGroup = {
  kind: "single"
  item: TimelineItem
}

type TimelineToolRunGroup = {
  kind: "tool-run"
  key: string
  items: TimelineItem[]
}

type TimelineGroup = TimelineSingleGroup | TimelineToolRunGroup

function groupTimelineItems(items: TimelineItem[], approvalTargetIds: Set<string>): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  let pendingTools: TimelineItem[] = []

  const flushTools = () => {
    if (pendingTools.length >= 2) {
      groups.push({
        kind: "tool-run",
        key: pendingTools.map((item) => item.id).join(":"),
        items: pendingTools,
      })
    } else {
      for (const item of pendingTools) groups.push({ kind: "single", item })
    }
    pendingTools = []
  }

  for (const item of items) {
    if (isToolRunBarItem(item) && !approvalTargetIds.has(item.id)) {
      pendingTools.push(item)
      continue
    }
    flushTools()
    groups.push({ kind: "single", item })
  }
  flushTools()
  return groups
}

function isToolRunBarItem(item: TimelineItem): boolean {
  if (item.type === "tool") return true
  if (item.type !== "artifact") return false
  return (item.content.kind ?? "artifact") !== "diff"
}

function ToolRunGroup({
  group,
  token,
  session,
  approvalByTarget,
  resolvingApprovalId,
  resolvingStatus,
  onResolveApproval,
}: {
  group: TimelineToolRunGroup
  token: string
  session: SessionView
  approvalByTarget: Map<string | null, Approval>
  resolvingApprovalId: string | null
  resolvingStatus: ApprovalResolveStatus | null
  onResolveApproval: (approvalId: string, status: ApprovalResolveStatus) => void
}) {
  const tSession = useTranslations("dashboard.session")
  const [open, setOpen] = React.useState(false)
  const summary = toolRunSummary(group.items, tSession)

  if (open) {
    return (
      <div className="min-w-0 max-w-full space-y-2 overflow-hidden">
        <button
          type="button"
          className="group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-muted-foreground transition-colors hover:bg-muted/35 hover:text-foreground"
          onClick={() => setOpen(false)}
        >
          <ChevronDown className="size-3.5 shrink-0 transition-transform" />
          <span className="code-mono min-w-0 flex-1 truncate text-sm">{summary}</span>
        </button>
        {group.items.map((item) => (
          <TimelineEntry
            key={item.id}
            token={token}
            session={session}
            item={item}
            approval={approvalByTarget.get(item.id)}
            resolvingApprovalId={resolvingApprovalId}
            resolvingStatus={resolvingStatus}
            onResolveApproval={onResolveApproval}
          />
        ))}
      </div>
    )
  }

  return (
    <button
      type="button"
      className="group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-muted-foreground transition-colors hover:bg-muted/35 hover:text-foreground"
      onClick={() => setOpen(true)}
    >
      <ChevronDown className="size-3.5 shrink-0 -rotate-90 transition-transform" />
      <span className="code-mono min-w-0 flex-1 truncate text-sm">{summary}</span>
    </button>
  )
}

function toolRunSummary(
  items: TimelineItem[],
  tSession: (key: string, values?: Record<string, string | number>) => string,
): string {
  let commands = 0
  let createdFiles = 0
  let changedFiles = 0
  for (const item of items) {
    const kind = textOf(item.content.kind)
    if (kind === "command") {
      commands += 1
      continue
    }
    if (kind === "file_change") {
      for (const change of recordsOf(item.content.changes)) {
        if (isCreatedFileChange(change)) createdFiles += 1
        else changedFiles += 1
      }
    }
  }

  const parts: string[] = []
  if (commands > 0) parts.push(tSession("toolSummaryCommands", { count: commands }))
  if (changedFiles > 0) parts.push(tSession("toolSummaryChangedFiles", { count: changedFiles }))
  if (createdFiles > 0) parts.push(tSession("toolSummaryCreatedFiles", { count: createdFiles }))
  return parts.length > 0 ? parts.join(", ") : tSession("toolSummaryItems", { count: items.length })
}

function mergeSessionState(
  current: SessionStateResponse | null,
  envelope: SessionEventEnvelope,
): SessionStateResponse | null {
  if (!current) {
    if (envelope.session && envelope.items && envelope.approvals && typeof envelope.nextSeq === "number") {
      return {
        session: envelope.session,
        items: envelope.items,
        approvals: envelope.approvals,
        nextSeq: envelope.nextSeq,
        hasMore: Boolean(envelope.hasMore),
        serverTime: envelope.serverTime ?? new Date().toISOString(),
      }
    }
    return current
  }

  const byId = new Map(current.items.map((item) => [item.id, item]))
  for (const item of envelope.items ?? []) {
    const existing = byId.get(item.id)
    if (!existing || existing.updatedSeq <= item.updatedSeq) byId.set(item.id, item)
  }

  return {
    ...current,
    session: envelope.session ?? current.session,
    items: Array.from(byId.values()).sort((a, b) => a.orderSeq - b.orderSeq || a.updatedSeq - b.updatedSeq),
    approvals: envelope.approvals ?? current.approvals,
    nextSeq: Math.max(current.nextSeq, envelope.nextSeq ?? current.nextSeq),
    hasMore: envelope.hasMore ?? current.hasMore,
    serverTime: envelope.serverTime ?? current.serverTime,
  }
}
