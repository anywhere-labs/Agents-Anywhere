"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Copy,
  ExternalLink,
  FilePenLine,
  Hammer,
  Loader2,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  X,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { highlightCode } from "@/lib/code-highlight"
import {
  AttachmentButton,
  AttachmentPreviewList,
  DragOverlay,
  useAttachments,
  type AttachedFile,
} from "@/components/attachment-input"
import { openNativeFilePreviewWindow } from "@/components/panels/files-panel"
import { dashboardApi } from "@/features/dashboard/api"
import {
  composerMenuOptions,
  effectiveFieldValue,
  filterClaudeEffortField,
  optionLabel,
  permissionLabelKey,
  runtimeConfigFields,
} from "@/features/dashboard/runtime-config"
import type {
  Approval,
  ApprovalResolveStatus,
  RuntimeConfigSchema,
  SessionStateResponse,
  SessionView,
  TimelineItem,
} from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

type SessionDetailProps = {
  token: string
  sessionId: string
  fallbackSession: SessionView | null
  onSessionUpdated?: (session: SessionView) => void
}

type SessionEventEnvelope = Partial<SessionStateResponse> & {
  sessionId?: string
  refetch?: boolean
}

const AUTO_SCROLL_BOTTOM_DISTANCE = 180
const SCROLL_TO_BOTTOM_INTERVAL_MS = 1000

export function SessionDetail({
  token,
  sessionId,
  fallbackSession,
  onSessionUpdated,
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
    const next = await dashboardApi.getSessionState(token, sessionId, 0, 500)
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
    dashboardApi
      .getSessionState(token, sessionId, 0, 500)
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
      dashboardApi
        .getSessionState(token, sessionId, 0, 500)
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

  const approvals = state?.approvals ?? []
  const approvalByTarget = new Map(approvals.map((approval) => [approval.targetItemId, approval]))
  const detachedApprovals = approvals.filter((approval) => approval.status === "pending" && !approval.targetItemId)
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending")
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
          <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-3 overflow-hidden px-5 py-6">
            {loading && !state ? <SessionSkeletonInline /> : null}
            {state && state.items.length === 0 && detachedApprovals.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">{tSession("noActivity")}</p>
            ) : null}
            {state?.items.map((item) => (
              <TimelineEntry
                key={item.id}
                token={token}
                session={session}
                item={item}
                approval={approvalByTarget.get(item.id)}
                resolvingApprovalId={resolvingApprovalId}
                resolvingStatus={resolvingStatus}
                onResolveApproval={handleResolveApproval}
              />
            ))}
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
            className="absolute bottom-4 left-1/2 z-10 h-8 -translate-x-1/2 gap-1.5 rounded-full border bg-background/95 px-3 shadow-lg backdrop-blur"
            onClick={scrollToBottom}
          >
            <ArrowDown className="size-3.5" />
            {tSession("bottom")}
          </Button>
        ) : null}
      </div>

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

function TimelineEntry({
  token,
  session,
  item,
  approval,
  resolvingApprovalId,
  resolvingStatus,
  onResolveApproval,
}: {
  token: string
  session: SessionView
  item: TimelineItem
  approval?: Approval
  resolvingApprovalId: string | null
  resolvingStatus: ApprovalResolveStatus | null
  onResolveApproval: (approvalId: string, status: ApprovalResolveStatus) => void
}) {
  if (item.type === "turn.start" || item.type === "turn.end") return null
  if (item.type === "message") return <MessageCard token={token} session={session} item={item} />
  if (item.type === "tool") {
    return (
      <ToolCard
        item={item}
        approval={approval}
        resolvingApprovalId={resolvingApprovalId}
        resolvingStatus={resolvingStatus}
        onResolveApproval={onResolveApproval}
      />
    )
  }
  if (item.type === "system") return <SystemCard item={item} />
  if (item.type === "artifact") return <ArtifactCard item={item} />
  return null
}

function MessageCard({ token, session, item }: { token: string; session: SessionView; item: TimelineItem }) {
  const text = messageText(item)
  const isUser = item.role === "user"
  return (
    <div className={cn("flex min-w-0 max-w-full overflow-hidden", isUser && "justify-end")}>
      <div
        className={cn(
          "min-w-0 max-w-[88%] text-sm leading-relaxed",
          isUser ? "bg-secondary text-secondary-foreground" : "bg-transparent px-0",
          isUser ? "rounded-2xl px-4 py-3" : "px-0 py-1",
        )}
      >
        {text ? <MarkdownText text={text} token={token} session={session} /> : <JsonBlock value={item.content} />}
      </div>
    </div>
  )
}

function ToolCard({
  item,
  approval,
  resolvingApprovalId,
  resolvingStatus,
  onResolveApproval,
}: {
  item: TimelineItem
  approval?: Approval
  resolvingApprovalId: string | null
  resolvingStatus: ApprovalResolveStatus | null
  onResolveApproval: (approvalId: string, status: ApprovalResolveStatus) => void
}) {
  const tSession = useTranslations("dashboard.session")
  const kind = textOf(item.content.kind) || "tool"
  const title =
    kind === "command"
      ? tSession("toolRan", { command: commandText(item.content.command) || tSession("toolCommandFallback") })
      : kind === "file_change"
        ? tSession("toolChangedFiles")
        : kind === "web_search"
          ? tSession("toolSearched", { query: textOf(item.content.query) || tSession("toolWebFallback") })
          : kind === "mcp"
            ? `${textOf(item.content.server) || tSession("toolMcpFallback")} / ${
                textOf(item.content.tool) || tSession("toolToolFallback")
              }`
            : kind
  const command = commandText(item.content.command)
  const output = textOf(item.content.outputPreview) || textOf(item.content.outputText) || textOf(item.content.error)
  const changes = recordsOf(item.content.changes)
  const defaultOpen = Boolean(approval)

  return (
    <Collapsible defaultOpen={defaultOpen} className="min-w-0 max-w-full overflow-hidden">
      <div className="min-w-0 max-w-full space-y-2 overflow-hidden">
        <CollapsibleTrigger asChild>
          <button className="group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-muted-foreground transition-colors hover:bg-muted/35 hover:text-foreground">
            <ChevronDown className="size-3.5 shrink-0 -rotate-90 transition-transform group-data-[state=open]:rotate-0" />
            <ToolIcon kind={kind} status={item.status} />
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{title}</span>
            <TimelineStatusBadge status={item.status} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
          <ToolDetailPanel command={command} output={output} changes={changes} fallback={item.content} />
          {approval ? (
            <div className="mt-2">
              <ApprovalCard
                approval={approval}
                resolvingApprovalId={resolvingApprovalId}
                resolvingStatus={resolvingStatus}
                onResolveApproval={onResolveApproval}
                compact
              />
            </div>
          ) : null}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function ApprovalCard({
  approval,
  resolvingApprovalId,
  resolvingStatus,
  onResolveApproval,
  compact,
}: {
  approval: Approval
  resolvingApprovalId: string | null
  resolvingStatus: ApprovalResolveStatus | null
  onResolveApproval: (approvalId: string, status: ApprovalResolveStatus) => void
  compact?: boolean
}) {
  const tSession = useTranslations("dashboard.session")
  const resolving = resolvingApprovalId === approval.id
  const disabled = resolvingApprovalId !== null
  return (
    <div className={cn("rounded-xl border border-border bg-muted/25 p-3", compact && "rounded-lg")}>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="break-words text-sm font-medium">{approval.title || tSession("approvalRequested")}</div>
            {approval.description ? (
              <p className="mt-0.5 break-words text-sm text-muted-foreground">{approval.description}</p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 md:flex-nowrap">
          {approval.choices.includes("reject") ? (
            <Button
              variant="outline"
              size="sm"
              className="whitespace-nowrap"
              disabled={disabled}
              onClick={() => onResolveApproval(approval.id, "rejected")}
            >
              {resolving && resolvingStatus === "rejected" ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
              {tSession("reject")}
            </Button>
          ) : null}
          {approval.choices.includes("approve_for_session") ? (
            <Button
              variant="outline"
              size="sm"
              className="whitespace-nowrap"
              disabled={disabled}
              onClick={() => onResolveApproval(approval.id, "approved_for_session")}
            >
              {resolving && resolvingStatus === "approved_for_session" ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
              {tSession("approveSession")}
            </Button>
          ) : null}
          {approval.choices.includes("approve") ? (
            <Button
              size="sm"
              className="whitespace-nowrap"
              disabled={disabled}
              onClick={() => onResolveApproval(approval.id, "approved")}
            >
              {resolving && resolvingStatus === "approved" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {tSession("approve")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SystemCard({ item }: { item: TimelineItem }) {
  const kind = textOf(item.content.kind) || "system"
  if (kind === "reasoning") return <ReasoningEntry item={item} />
  const text = textOf(item.content.text) || textOf(item.content.message) || textOf(item.content.rawText)
  const failed = item.status === "failed" || kind === "error"
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", failed ? "border-destructive/35 bg-destructive/5 text-destructive" : "border-border bg-muted/20 text-muted-foreground")}>
      {failed ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <Clock className="mt-0.5 size-4 shrink-0" />}
      <div className="min-w-0">
        <div className="font-medium">{kind}</div>
        <div className="break-words">{text || item.status}</div>
      </div>
    </div>
  )
}

function ReasoningEntry({ item }: { item: TimelineItem }) {
  const tSession = useTranslations("dashboard.session")
  const summaries = recordsOf(item.content.summaries)
    .map((summary) => textOf(summary.text))
    .filter((text): text is string => Boolean(text))
  const rawText = textOf(item.content.rawText) || textOf(item.content.text)
  const lines = summaries.length > 0 ? summaries : rawText ? [rawText] : []
  return (
    <div className="space-y-2">
      <div className="inline-flex h-7 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-xs font-medium text-secondary-foreground">
        <Sparkles className="size-3.5" />
        {tSession("reasoning")}
      </div>
      {lines.length > 0 ? (
        <div className="space-y-2 pl-1 text-sm leading-relaxed text-muted-foreground">
          {lines.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ArtifactCard({ item }: { item: TimelineItem }) {
  const kind = textOf(item.content.kind) || "artifact"
  if (kind === "diff") return null
  return (
    <Collapsible className="min-w-0 max-w-full overflow-hidden">
      <div className="min-w-0 max-w-full space-y-2 overflow-hidden">
        <CollapsibleTrigger asChild>
          <button className="group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-muted-foreground transition-colors hover:bg-muted/35 hover:text-foreground">
            <ChevronDown className="size-3.5 shrink-0 -rotate-90 transition-transform group-data-[state=open]:rotate-0" />
            <FilePenLine className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{kind}</span>
            <TimelineStatusBadge status={item.status} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
          <JsonBlock value={item.content} />
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function SessionComposer({
  session,
  pendingApprovalCount,
  error,
  sending,
  takeoverBusy,
  runtimeSchema,
  runtimeSettings,
  runtimeSettingsError,
  runtimeSettingsBusy,
  onDismissError,
  onPatchRuntimeSettings,
  onSend,
  onInterrupt,
  onToggleTakeover,
}: {
  session: SessionView
  pendingApprovalCount: number
  error: string | null
  sending: boolean
  takeoverBusy: boolean
  runtimeSchema: RuntimeConfigSchema | null
  runtimeSettings: Record<string, unknown> | null
  runtimeSettingsError: string | null
  runtimeSettingsBusy: boolean
  onDismissError: () => void
  onPatchRuntimeSettings: (settings: Record<string, unknown>) => void
  onSend: (content: string, attachments: AttachedFile[]) => void
  onInterrupt: () => void
  onToggleTakeover: () => void
}) {
  const tSession = useTranslations("dashboard.session")
  const tNew = useTranslations("dashboard.new")
  const [value, setValue] = React.useState("")
  const { attachments, isDragging, add, remove, clear, onDragEnter, onDragLeave, onDragOver, onDrop } =
    useAttachments()
  const isBusy = session.status === "running" || session.status === "waiting_approval"
  const connectorOnline = session.connectorStatus === "online"
  const canSend =
    connectorOnline &&
    session.takeover &&
    !sending &&
    (session.status === "idle" || session.status === "error")
  const hasInput = value.trim().length > 0 || attachments.length > 0
  const showInterrupt = isBusy && !hasInput
  const settingsFields = runtimeConfigFields(runtimeSchema, runtimeSettings, "session")
  const permissionField = settingsFields.find((field) => field.key === "permissionMode")
  const modelField = settingsFields.find((field) => field.key === "model")
  const effortField = filterClaudeEffortField(
    session.runtime,
    settingsFields.find((field) => field.key === "effort"),
    runtimeSettings?.model,
  )
  const permissionItems = composerMenuOptions(permissionField)
  const modelItems = composerMenuOptions(modelField)
  const effortItems = composerMenuOptions(effortField)
  const permissionValue = stringSetting(runtimeSettings?.permissionMode)
  const modelValue = effectiveFieldValue(modelField, runtimeSettings?.model)
  const effortValue = effectiveFieldValue(effortField, runtimeSettings?.effort)
  const selectedPermissionLabelKey = permissionLabelKey(permissionValue)
  const permissionLabel = selectedPermissionLabelKey
    ? tNew(selectedPermissionLabelKey)
    : optionLabel(permissionField, runtimeSettings?.permissionMode, tNew("permissionMode"))
  const modelLabel = optionLabel(modelField, runtimeSettings?.model, tNew("model"))
  const effortLabel = optionLabel(effortField, runtimeSettings?.effort, tNew("reasoning"))
  const hasSelectors = Boolean(permissionField || modelField || effortField)
  const placeholder = !session.takeover
    ? tSession("readOnlyPlaceholder")
    : !connectorOnline
      ? tSession("deviceOfflinePlaceholder")
      : pendingApprovalCount > 0
        ? tSession("waitingApprovalPlaceholder")
        : isBusy
          ? tSession("busyPlaceholder")
          : session.status === "error"
            ? tSession("errorPlaceholder")
            : tSession("replyPlaceholder")

  const submit = () => {
    if (!canSend || !hasInput) return
    const text = value
    setValue("")
    const files = attachments
    clear()
    onSend(text, files)
  }

  return (
    <div
      className="shrink-0 bg-background/95 px-4 pb-4 pt-2 backdrop-blur"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <DragOverlay isDragging={isDragging} />
      <div className="mx-auto w-full max-w-3xl space-y-2">
        {pendingApprovalCount > 0 ? (
          <div className="flex items-center justify-between rounded-2xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
            <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
              <ShieldCheck className="size-4" />
              <span>
                {tSession(pendingApprovalCount > 1 ? "approvalPendingPlural" : "approvalPending", {
                  count: pendingApprovalCount,
                })}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">{tSession("resolveAbove")}</span>
          </div>
        ) : null}
        {error ? (
          <button type="button" className="block text-left text-sm text-destructive" onClick={onDismissError}>
            {error}
          </button>
        ) : null}
        <div
          className={cn(
            "relative rounded-2xl border border-border bg-card shadow-sm transition-colors",
            isDragging && "border-primary bg-primary/5",
          )}
        >
          {isDragging ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-background/75 text-sm font-medium text-foreground backdrop-blur-sm">
              {tSession("dropFiles")}
            </div>
          ) : null}
          <div className="space-y-3 px-4 pt-4">
            <AttachmentPreviewList attachments={attachments} onRemove={remove} />
            <Textarea
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  submit()
                }
              }}
              placeholder={placeholder}
              disabled={!session.takeover || !connectorOnline}
              className="min-h-12 max-h-40 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1 px-3 pb-3 pt-2">
            <AttachmentButton
              attachments={attachments}
              onAttach={add}
              isDragging={isDragging}
              className="size-8"
            />
            {hasSelectors ? (
              <>
                {permissionField ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 rounded-xl px-2.5 text-muted-foreground"
                        disabled={!runtimeSettings || runtimeSettingsBusy}
                      >
                        <span className="size-1.5 rounded-full bg-primary" />
                        <span className="text-foreground">{permissionLabel}</span>
                        <ChevronDown className="size-3.5 opacity-60" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64">
                      {permissionItems.map((item) => (
                        <DropdownMenuItem
                          key={item.id}
                          className="gap-2"
                          onSelect={() => onPatchRuntimeSettings({ permissionMode: item.id })}
                        >
                          <Check className={cn("size-3.5", permissionValue === item.id ? "opacity-100" : "opacity-0")} />
                          <span>
                            {permissionLabelKey(item.id) ? tNew(permissionLabelKey(item.id)!) : item.label}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                {modelField || effortField ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 rounded-xl px-2.5 text-muted-foreground"
                        disabled={!runtimeSettings || runtimeSettingsBusy}
                      >
                        {effortField ? <span className="text-foreground">{effortLabel}</span> : null}
                        {effortField && modelField ? <span className="text-muted-foreground/50">·</span> : null}
                        {modelField ? <span className="max-w-40 truncate text-foreground">{modelLabel}</span> : null}
                        <ChevronDown className="size-3.5 opacity-60" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      {effortItems.length > 0 ? (
                        <>
                          {effortItems.map((item) => (
                            <DropdownMenuItem
                              key={item.id}
                              className="gap-2"
                              onSelect={() => onPatchRuntimeSettings({ effort: item.id })}
                            >
                              <Check className={cn("size-3.5", effortValue === item.id ? "opacity-100" : "opacity-0")} />
                              <span>{item.label}</span>
                            </DropdownMenuItem>
                          ))}
                        </>
                      ) : null}
                      {effortItems.length > 0 && modelItems.length > 0 ? <DropdownMenuSeparator /> : null}
                      {modelItems.length > 0 ? (
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger className="gap-2">
                            <span className="size-3.5" />
                            <span className="max-w-40 truncate">{modelLabel}</span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-56">
                            {modelItems.map((item) => (
                              <DropdownMenuItem
                                key={item.id}
                                className="gap-2"
                                onSelect={() => onPatchRuntimeSettings({ model: item.id })}
                              >
                                <Check className={cn("size-3.5", modelValue === item.id ? "opacity-100" : "opacity-0")} />
                                <span className="truncate">{item.label}</span>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </>
            ) : null}
            <div
              role="switch"
              aria-checked={session.takeover}
              aria-disabled={!connectorOnline || takeoverBusy}
              tabIndex={connectorOnline && !takeoverBusy ? 0 : -1}
              className={cn(
                "ml-auto flex h-8 items-center gap-2 rounded-xl px-2.5 text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                connectorOnline && !takeoverBusy && "cursor-pointer hover:bg-accent hover:text-accent-foreground",
                (!connectorOnline || takeoverBusy) && "opacity-50",
                session.takeover && "text-foreground",
              )}
              onClick={() => {
                if (!connectorOnline || takeoverBusy) return
                onToggleTakeover()
              }}
              onKeyDown={(event) => {
                if (!connectorOnline || takeoverBusy) return
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  onToggleTakeover()
                }
              }}
            >
              {takeoverBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Switch
                  size="sm"
                  checked={session.takeover}
                  tabIndex={-1}
                  aria-hidden
                  className="pointer-events-none"
                />
              )}
              {tSession("takeover")}
            </div>
            <span className="mx-1 h-5 w-px bg-border" />
            <Button
              type="button"
              size="icon"
              aria-label={showInterrupt ? tSession("interrupt") : tSession("send")}
              className={cn("size-8 rounded-full", showInterrupt && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              disabled={showInterrupt ? !connectorOnline : !canSend || !hasInput}
              onClick={showInterrupt ? onInterrupt : submit}
            >
              {sending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : showInterrupt ? (
                <Square className="size-4" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </div>
        </div>
        {runtimeSettingsError ? (
          <div className="text-xs text-destructive">{runtimeSettingsError}</div>
        ) : null}
      </div>
    </div>
  )
}

function MarkdownText({
  text,
  token,
  session,
  inverted,
}: {
  text: string
  token?: string
  session?: SessionView
  inverted?: boolean
}) {
  return (
    <div
      className={cn(
        "space-y-3 text-sm leading-relaxed [&_a]:underline [&_blockquote]:border-l [&_blockquote]:pl-3 [&_code]:font-mono [&_code]:text-[0.92em] [&_li]:ml-5 [&_ol]:list-decimal [&_pre]:m-0 [&_ul]:list-disc",
        inverted
          ? "[&_pre]:border-primary-foreground/15"
          : "[&_pre]:border-border",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? "")
            const code = String(children).replace(/\n$/, "")
            if (!match) {
              const previewPath = typeof children === "string" ? parseInlineFileRef(children) : null
              if (previewPath && token && session) {
                return (
                  <span
                    role="button"
                    tabIndex={0}
                    className="inline-flex max-w-full items-baseline gap-0.5 rounded-none bg-transparent p-0 align-baseline font-mono text-[0.92em] text-inherit underline underline-offset-2 hover:text-foreground"
                    onClick={() => openSessionFilePreview(token, session, previewPath)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") openSessionFilePreview(token, session, previewPath)
                    }}
                  >
                    <span className="min-w-0 truncate">{children}</span>
                    <ExternalLink className="relative -top-0.5 size-3 shrink-0" />
                  </span>
                )
              }
              return (
                <code
                  className={cn(
                    className,
                    "rounded-md bg-secondary px-1.5 py-0.5 text-secondary-foreground",
                  )}
                  {...props}
                >
                  {children}
                </code>
              )
            }
            return <MarkdownCodeBlock code={code} language={match[1] ?? "text"} />
          },
          a({ href, children, node: _node, ...props }) {
            const childText = textFromReactChildren(children)
            const path = href && isMarkdownFilePath(href)
              ? stripLineSuffix(href)
              : parseInlineFileRef(childText)
            if (!path || !token || !session) {
              return (
                <a href={href} target="_blank" rel="noreferrer" {...props}>
                  {children}
                </a>
              )
            }
            return (
              <span
                role="button"
                tabIndex={0}
                className="inline-flex max-w-full items-baseline gap-0.5 align-baseline text-left underline underline-offset-2 hover:text-foreground"
                onClick={() => openSessionFilePreview(token, session, path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") openSessionFilePreview(token, session, path)
                }}
              >
                <span className="min-w-0 truncate">{children}</span>
                <ExternalLink className="relative -top-0.5 size-3 shrink-0" />
              </span>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function MarkdownCodeBlock({ code, language }: { code: string; language: string }) {
  const tSession = useTranslations("dashboard.session")
  const [copied, setCopied] = React.useState(false)
  return (
    <div className="my-3 min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex h-9 items-center justify-between border-b bg-muted/25 px-3">
        <span className="font-mono text-xs text-muted-foreground">{language || "text"}</span>
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            navigator.clipboard.writeText(code).catch(() => undefined)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
          aria-label={tSession("copyCode")}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <ScrollArea contentWide className="max-h-96 min-w-0 max-w-full overflow-hidden">
        <pre className="w-max min-w-full p-3 font-mono text-xs leading-relaxed">
          <code>{highlightCode(code, language)}</code>
        </pre>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  )
}

function stripLineSuffix(path: string) {
  return path.replace(/:\d+(?::\d+)?$/, "")
}

function parseInlineFileRef(text: string): string | null {
  if (!text || text.includes(" ") || text.includes("://")) return null
  if (!text.includes("/")) return null
  if (!/\.[a-zA-Z0-9]+(?::\d+(?::\d+)?)?$/.test(text)) return null
  return stripLineSuffix(text)
}

function textFromReactChildren(children: React.ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(textFromReactChildren).join("")
  return ""
}

function isMarkdownFilePath(href: string): boolean {
  if (!href) return false
  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#") ||
    href.startsWith("//")
  ) {
    return false
  }
  return true
}

function openSessionFilePreview(token: string, session: SessionView, path: string) {
  openNativeFilePreviewWindow({
    token,
    connectorId: session.connectorId,
    root: session.cwd || ".",
    file: { name: fileNameFromPath(path), path },
  })
}

function fileNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized.split("/").pop() || path
}

function ToolDetailPanel({
  command,
  output,
  changes,
  fallback,
}: {
  command: string | null
  output: string | null
  changes: Array<Record<string, unknown>>
  fallback: unknown
}) {
  const hasContent = Boolean(command || output || changes.length > 0)
  if (!hasContent) return <JsonBlock value={fallback} />
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-background">
      {command ? <CodePanel label="command" code={command} language="bash" flush /> : null}
      {changes.length > 0 ? (
        <div className={cn(command && "border-t")}>
          {changes.map((change, index) => (
            <FileChangeRow change={change} key={`${textOf(change.path) ?? "change"}-${index}`} />
          ))}
        </div>
      ) : null}
      {output ? (
        <div className={cn((command || changes.length > 0) && "border-t")}>
          <CodePanel label="output" code={output} language="text" flush />
        </div>
      ) : null}
    </div>
  )
}

function CodePanel({ label, code, language, flush }: { label: string; code: string; language: string; flush?: boolean }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div className={cn("min-w-0 max-w-full overflow-hidden bg-background", !flush && "rounded-xl border border-border")}>
      <div className="flex h-9 items-center justify-between border-b bg-muted/25 px-3">
        <span className="font-mono text-xs text-muted-foreground">{label}</span>
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            navigator.clipboard.writeText(code).catch(() => undefined)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <ScrollArea contentWide className="max-h-80 min-w-0 max-w-full overflow-hidden">
        <pre className="w-max min-w-full p-3 font-mono text-xs leading-relaxed text-foreground">
          <code>{highlightCode(code, language)}</code>
        </pre>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  )
}

function JsonBlock({ value }: { value: unknown }) {
  return <CodePanel label="json" code={JSON.stringify(value, null, 2)} language="json" />
}

function FileChangeRow({ change }: { change: Record<string, unknown> }) {
  const path = textOf(change.path) ?? "unknown path"
  const diff = textOf(change.diff)
  return (
    <div className="min-w-0 max-w-full overflow-hidden border-b last:border-b-0">
      <div className="flex h-9 items-center gap-2 bg-muted/20 px-3 text-sm">
        <FilePenLine className="size-4 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-xs">{path}</span>
      </div>
      {diff ? <CodePanel label="diff" code={diff} language="diff" flush /> : null}
    </div>
  )
}

function ToolIcon({ kind, status }: { kind: string; status: TimelineItem["status"] }) {
  const className = cn("size-4", status === "failed" ? "text-destructive" : "text-muted-foreground")
  if (kind === "command") return <TerminalSquare className={className} />
  if (kind === "file_change") return <FilePenLine className={className} />
  if (status === "running") return <Loader2 className={cn(className, "animate-spin")} />
  return <Hammer className={className} />
}

function TimelineStatusBadge({ status }: { status: TimelineItem["status"] }) {
  const variant = status === "failed" ? "destructive" : "secondary"
  return (
    <Badge variant={variant} className="h-5 text-[11px] font-normal">
      {status}
    </Badge>
  )
}

function SessionSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-8">
      <SessionSkeletonInline />
    </div>
  )
}

function SessionSkeletonInline() {
  return (
    <>
      <Skeleton className="h-20 w-2/3" />
      <Skeleton className="ml-auto h-16 w-1/2" />
      <Skeleton className="h-32 w-full" />
    </>
  )
}

function messageText(item: TimelineItem): string {
  return (
    textOf(item.content.text) ||
    textOf(item.content.content) ||
    textOf(item.content.message) ||
    textOf(item.content.rawText) ||
    ""
  )
}

function runtimeLabel(runtime: string): string {
  return runtime.slice(0, 1).toUpperCase() + runtime.slice(1)
}

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function commandText(value: unknown): string | null {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((part) => String(part)).join(" ")
  return null
}

function stringSetting(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function recordsOf(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
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
