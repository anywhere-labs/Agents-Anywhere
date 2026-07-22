"use client"

import * as React from "react"
import { ArrowDown, ChevronDown, CircleAlert, Loader2, WifiOff } from "lucide-react"
import { toast } from "sonner"

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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller"
import { createClientId } from "@/lib/id"
import { cn } from "@/lib/utils"
import { dashboardApi } from "@/features/dashboard/api"
import type {
  Notice,
  ProtocolCapabilitySet,
  ProtocolEventEnvelope,
  ProtocolModelCatalog,
  ProtocolPermissionCatalog,
  SessionSnapshotResponse,
  SessionStateResponse,
  SessionView,
  TimelineItem,
} from "@/features/dashboard/types"
import { useTranslations } from "next-intl"
import { InteractionCard, NotificationCard } from "@/components/session/session-approval-card"
import { SessionSkeleton, SessionSkeletonInline } from "@/components/session/session-skeleton"
import { TimelineEntry } from "@/components/session/session-timeline-entry"
import { isCreatedFileChange, JsonBlock } from "@/components/session/session-tool-cards"
import { SessionComposer, type AttachedFile } from "@/components/session/session-composer"
import {
  buildOptimisticUserMessage,
  isOptimisticTimelineItem,
  markOptimisticItemFailed,
  mergeTimelineItems,
  preserveOptimisticItems,
  timelineClientMessageId,
} from "@/components/session/optimistic-timeline"
import { recordsOf, runtimeLabel, sortTimelineItems, textOf } from "@/components/session/session-utils"
import { useWorkspace } from "@/components/workspace-context"

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
  notices: Notice[]
  nextSeq: number
  hasMore: boolean
  serverTime: string
  pendingInteractionCount: number
}

type SessionRemoteState = SessionStateResponse & {
  notices: Notice[]
  eventCursor: string
  effectiveCapabilities: ProtocolCapabilitySet | null
  catalogs: {
    model?: ProtocolModelCatalog
    permission?: ProtocolPermissionCatalog
    [key: string]: unknown
  }
}

const INITIAL_TIMELINE_LIMIT = 100
const TIMELINE_PAGE_LIMIT = 100
const LOAD_OLDER_SCROLL_THRESHOLD = 96
const SESSION_REFRESH_RETRY_LIMIT = 3
const SESSION_REFRESH_RETRY_DELAY_MS = 700
const COMPOSER_DRAFT_STORAGE_PREFIX = "agents-anywhere.sessionComposerDraft.v1."
const COMPOSER_BLUR_LAYERS = buildComposerBlurLayers({
  height: 144,
  layerCount: 10,
  maxBlur: 14,
  minBlur: 0,
  overlap: 10,
  gamma: 1.8,
})

type ComposerDraftState = {
  sessionId: string
  value: string
}

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

async function loadInitialSessionState(
  token: string,
  sessionId: string,
  options: { syncRuntime?: boolean } = {},
): Promise<SessionRemoteState> {
  if (options.syncRuntime) {
    try {
      await dashboardApi.syncSession(token, sessionId)
    } catch {
      // Opening a session should still work when the connector is offline or
      // the runtime cannot provide a fresh snapshot. The HTTP snapshot remains
      // the fallback source of truth.
    }
  }
  return sessionStateFromSnapshot(await dashboardApi.getSessionSnapshot(token, sessionId, INITIAL_TIMELINE_LIMIT))
}

function sessionStateFromSnapshot(snapshot: SessionSnapshotResponse): SessionRemoteState {
  return {
    session: snapshot.session,
    items: sortTimelineItems(snapshot.timeline.items),
    approvals: [],
    notices: snapshot.notices,
    nextSeq: snapshot.timeline.nextSeq,
    hasMore: snapshot.timeline.hasMore,
    serverTime: snapshot.serverTime,
    eventCursor: snapshot.eventCursor,
    effectiveCapabilities: snapshot.effectiveCapabilities,
    catalogs: snapshot.catalogs,
  }
}

function composerDraftStorageKey(sessionId: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${sessionId}`
}

function readComposerDraft(sessionId: string): string {
  try {
    return window.localStorage.getItem(composerDraftStorageKey(sessionId)) ?? ""
  } catch {
    return ""
  }
}

function writeComposerDraft(sessionId: string, value: string) {
  try {
    const key = composerDraftStorageKey(sessionId)
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    // Draft persistence is best-effort; private contexts can still use the composer.
  }
}

function hasRealTimelineItemForClientMessage(items: TimelineItem[], clientMessageId: string): boolean {
  return items.some((item) =>
    !isOptimisticTimelineItem(item) && timelineClientMessageId(item) === clientMessageId,
  )
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
  const {
    addOptimisticMessage,
    clearResolvedOptimisticMessages,
    composerInsertion,
    getOptimisticItems,
    getOptimisticSessionState,
    isOptimisticSession,
    markOptimisticMessageFailed,
    sessionRefreshRequest,
  } = useWorkspace()
  const [state, setState] = React.useState<SessionRemoteState | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const [interrupting, setInterrupting] = React.useState(false)
  const [takeoverBusy, setTakeoverBusy] = React.useState(false)
  const [resolvingNoticeId, setResolvingNoticeId] = React.useState<string | null>(null)
  const [resolvingActionId, setResolvingActionId] = React.useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  const [scrollToEndRequest, setScrollToEndRequest] = React.useState(0)
  const [pendingTakeover, setPendingTakeover] = React.useState<boolean | null>(null)
  const [composerDraftState, setComposerDraftState] = React.useState<ComposerDraftState>(() => ({
    sessionId,
    value: readComposerDraft(sessionId),
  }))
  const nextSeqRef = React.useRef(0)
  const loadingOlderRef = React.useRef(false)

  const session = state?.session ?? fallbackSession
  const runtimeSettings = session?.runtimeSettings ?? null
  const composerDraft = composerDraftState.sessionId === sessionId ? composerDraftState.value : ""
  const isLocalOptimisticSession = isOptimisticSession(sessionId)

  const applyOptimisticItems = React.useCallback((next: SessionRemoteState): SessionRemoteState => ({
    ...next,
    items: mergeTimelineItems(next.items, getOptimisticItems(sessionId)),
  }), [getOptimisticItems, sessionId])
  const applyOptimisticItemsRef = React.useRef(applyOptimisticItems)
  const clearResolvedOptimisticMessagesRef = React.useRef(clearResolvedOptimisticMessages)
  const getOptimisticSessionStateRef = React.useRef(getOptimisticSessionState)
  const tSessionRef = React.useRef(tSession)

  React.useEffect(() => {
    applyOptimisticItemsRef.current = applyOptimisticItems
    clearResolvedOptimisticMessagesRef.current = clearResolvedOptimisticMessages
    getOptimisticSessionStateRef.current = getOptimisticSessionState
    tSessionRef.current = tSession
  }, [applyOptimisticItems, clearResolvedOptimisticMessages, getOptimisticSessionState, tSession])

  React.useEffect(() => {
    const optimisticState = getOptimisticSessionState(sessionId)
    if (isLocalOptimisticSession) {
      if (optimisticState) {
        setState({
          ...optimisticState,
          notices: [],
          eventCursor: `seq:${optimisticState.nextSeq}`,
          effectiveCapabilities: null,
          catalogs: {},
        })
      }
      return
    }
    const optimisticItems = getOptimisticItems(sessionId)
    if (optimisticItems.length === 0) return
    setState((current) => current ? { ...current, items: mergeTimelineItems(current.items, optimisticItems) } : current)
  }, [getOptimisticItems, getOptimisticSessionState, isLocalOptimisticSession, sessionId])

  React.useEffect(() => {
    setComposerDraftState({ sessionId, value: readComposerDraft(sessionId) })
  }, [sessionId])

  React.useEffect(() => {
    writeComposerDraft(composerDraftState.sessionId, composerDraftState.value)
  }, [composerDraftState])

  const setComposerDraft = React.useCallback((value: string) => {
    setComposerDraftState({ sessionId, value })
  }, [sessionId])

  React.useEffect(() => {
    if (!composerInsertion || composerInsertion.sessionId !== sessionId) return
    setComposerDraftState((current) => {
      const currentValue = current.sessionId === sessionId ? current.value : readComposerDraft(sessionId)
      const separator = currentValue.trim().length > 0 && !/\s$/.test(currentValue) ? " " : ""
      return {
        sessionId,
        value: `${currentValue}${separator}${composerInsertion.text}`,
      }
    })
  }, [composerInsertion, sessionId])

  React.useEffect(() => {
    if (!state) {
      onMemorySnapshotUpdated?.(null)
      return
    }
    onMemorySnapshotUpdated?.({
      session: state.session,
      items: state.items,
      notices: state.notices,
      nextSeq: state.nextSeq,
      hasMore: state.hasMore,
      serverTime: state.serverTime,
      pendingInteractionCount: blockingInteractions(state.notices, state.session.id).length,
    })
  }, [onMemorySnapshotUpdated, state])

  const refresh = React.useCallback(async (options: { scrollToBottom?: boolean; preserveBottom?: boolean } = {}) => {
    if (options.scrollToBottom) setScrollToEndRequest((current) => current + 1)
    setError(null)
    const next = applyOptimisticItemsRef.current(await loadInitialSessionState(token, sessionId))
    clearResolvedOptimisticMessagesRef.current(sessionId, next.items)
    setState((current) => current ? { ...next, items: preserveOptimisticItems(next.items, current.items) } : next)
    nextSeqRef.current = Math.max(nextSeqRef.current, next.nextSeq)
    onSessionUpdated?.(next.session)
    return next
  }, [onSessionUpdated, sessionId, token])

  React.useEffect(() => {
    if (!sessionRefreshRequest || sessionRefreshRequest.sessionId !== sessionId || isLocalOptimisticSession) return
    let cancelled = false
    let retryTimer: number | null = null

    const run = async (attempt: number) => {
      try {
        const next = await refresh({ scrollToBottom: true })
        if (cancelled) return
        const clientMessageId = sessionRefreshRequest.clientMessageId
        if (!clientMessageId || hasRealTimelineItemForClientMessage(next.items, clientMessageId)) return
        if (attempt >= SESSION_REFRESH_RETRY_LIMIT) return
        retryTimer = window.setTimeout(() => {
          retryTimer = null
          void run(attempt + 1)
        }, SESSION_REFRESH_RETRY_DELAY_MS)
      } catch {
        if (cancelled || attempt >= SESSION_REFRESH_RETRY_LIMIT) return
        retryTimer = window.setTimeout(() => {
          retryTimer = null
          void run(attempt + 1)
        }, SESSION_REFRESH_RETRY_DELAY_MS)
      }
    }

    void run(0)

    return () => {
      cancelled = true
      if (retryTimer !== null) window.clearTimeout(retryTimer)
    }
  }, [isLocalOptimisticSession, refresh, sessionId, sessionRefreshRequest])

  const loadOlderTimeline = React.useCallback(async () => {
    if (loadingOlderRef.current || loadingOlder || !state?.hasMore) return
    const oldestItem = state.items[0]
    if (!oldestItem) return

    loadingOlderRef.current = true
    setLoadingOlder(true)
    try {
      const older = await dashboardApi.getSessionStateBefore(
        token,
        sessionId,
        oldestItem.orderSeq,
        TIMELINE_PAGE_LIMIT,
      )
      setState((current) => {
        if (!current) return current
        if (older.items.length === 0) return { ...current, hasMore: older.hasMore, serverTime: older.serverTime }
        const items = mergeTimelineItems(older.items, current.items)
        return {
          ...current,
          items,
          hasMore: older.hasMore,
          nextSeq: Math.max(current.nextSeq, older.nextSeq),
          serverTime: older.serverTime,
        }
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tSession("loadFailed"))
    } finally {
      loadingOlderRef.current = false
      setLoadingOlder(false)
    }
  }, [loadingOlder, sessionId, state?.hasMore, state?.items, tSession, token])

  const handleTimelineScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget
    if (!viewport || viewport.scrollTop > LOAD_OLDER_SCROLL_THRESHOLD) return
    void loadOlderTimeline()
  }, [loadOlderTimeline])

  const requestScrollToEnd = React.useCallback(() => {
    setScrollToEndRequest((current) => current + 1)
  }, [])

  const pruneTimelineToInitialLimit = React.useCallback(() => {
    setState((current) =>
      current && current.items.length > INITIAL_TIMELINE_LIMIT
        ? { ...current, items: current.items.slice(-INITIAL_TIMELINE_LIMIT) }
        : current,
    )
  }, [])

  React.useEffect(() => {
    setSending(false)
    setInterrupting(false)
    setError(null)
    const optimisticState = getOptimisticSessionStateRef.current(sessionId)
    if (optimisticState) {
      setState({
        ...optimisticState,
        notices: [],
        eventCursor: `seq:${optimisticState.nextSeq}`,
        effectiveCapabilities: null,
        catalogs: {},
      })
      nextSeqRef.current = optimisticState.nextSeq
      setLoading(false)
    } else {
      setLoading(true)
      setState(null)
    }
  }, [
    isLocalOptimisticSession,
    onSessionUpdated,
    sessionId,
    token,
  ])

  React.useEffect(() => {
    if (isLocalOptimisticSession) return
    let cancelled = false
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let delayedRefetchTimer: number | null = null
    let refetchPromise: Promise<void> | null = null
    let recoveryPromise: Promise<void> | null = null
    let snapshotReady = false
    let bufferedEvents: ProtocolEventEnvelope[] = []
    const refetch = () => {
      if (refetchPromise) return refetchPromise
      refetchPromise = loadInitialSessionState(token, sessionId)
        .then((next) => {
          if (cancelled) return
          const merged = applyOptimisticItemsRef.current(next)
          clearResolvedOptimisticMessagesRef.current(sessionId, merged.items)
          nextSeqRef.current = Math.max(nextSeqRef.current, cursorSequence(next.eventCursor) || next.nextSeq)
          setState((current) => current ? { ...merged, items: preserveOptimisticItems(merged.items, current.items) } : merged)
          onSessionUpdated?.(next.session)
        })
        .catch(() => undefined)
        .finally(() => {
          refetchPromise = null
        })
      return refetchPromise
    }

    const scheduleRefetch = () => {
      if (cancelled || refetchPromise || delayedRefetchTimer !== null) return
      delayedRefetchTimer = window.setTimeout(() => {
        delayedRefetchTimer = null
        void refetch()
      }, 1200)
    }

    const applyEvent = (event: ProtocolEventEnvelope) => {
      if (cancelled || event.sessionId !== sessionId) return
      if (event.type === "keepalive") return
      if (event.type === "session.refetch_required") {
        void recoverEvents(nextSeqRef.current)
        return
      }
      setState((current) => mergeSessionEvent(current, event))
      const item = readPayloadValue<TimelineItem>(event.payload.item)
      if (item) clearResolvedOptimisticMessagesRef.current(sessionId, [item])
      nextSeqRef.current = Math.max(nextSeqRef.current, event.sequence)
    }

    const recoverEvents = async (afterSeq: number) => {
      if (recoveryPromise) return recoveryPromise
      try {
        recoveryPromise = dashboardApi.getSessionEvents(token, sessionId, `seq:${afterSeq}`)
          .then((recovery) => {
            if (cancelled) return
            if (recovery.snapshotRequired) {
              scheduleRefetch()
              return
            }
            for (const event of recovery.events) applyEvent(event)
          })
          .catch(() => {
            scheduleRefetch()
          })
          .finally(() => {
            recoveryPromise = null
          })
        return recoveryPromise
      } catch {
        scheduleRefetch()
      }
    }

    const connect = async () => {
      try {
        const ticket = await dashboardApi.createWsTicket(token, createClientId("web"), sessionId)
        if (cancelled) return
        socket = new WebSocket(dashboardApi.sessionWebSocketUrl(sessionId, ticket.ticket))
        socket.onmessage = (message) => {
          if (cancelled || typeof message.data !== "string") return
          const event = parseProtocolEvent(message.data)
          if (!event) return
          if (!snapshotReady) {
            bufferedEvents.push(event)
            return
          }
          applyEvent(event)
        }
        socket.onclose = () => {
          if (cancelled) return
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null
            void connect()
            void recoverEvents(nextSeqRef.current)
          }, 1200)
        }
      } catch {
        if (cancelled) return
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          void connect()
        }, 2000)
      }
    }

    void connect()

    loadInitialSessionState(token, sessionId, {
      syncRuntime: getOptimisticSessionStateRef.current(sessionId) === null,
    })
      .then((next) => {
        if (cancelled) return
        setError(null)
        const merged = applyOptimisticItemsRef.current(next)
        clearResolvedOptimisticMessagesRef.current(sessionId, merged.items)
        setState((current) => current ? { ...merged, items: preserveOptimisticItems(merged.items, current.items) } : merged)
        nextSeqRef.current = cursorSequence(next.eventCursor) || next.nextSeq
        onSessionUpdated?.(next.session)
        snapshotReady = true
        const pending = bufferedEvents
        bufferedEvents = []
        for (const event of pending.sort((a, b) => a.sequence - b.sequence)) applyEvent(event)
      })
      .catch((err) => {
        if (!cancelled) {
          snapshotReady = true
          setError(err instanceof Error ? err.message : tSessionRef.current("loadFailed"))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      if (delayedRefetchTimer !== null) window.clearTimeout(delayedRefetchTimer)
      socket?.close()
    }
  }, [
    isLocalOptimisticSession,
    onSessionUpdated,
    sessionId,
    token,
  ])

  const handleSend = async (
    content: string,
    attachments: AttachedFile[],
    selections: { modelSelectionId?: string; permissionSelectionId?: string },
  ): Promise<boolean> => {
    if (!session || (!content.trim() && attachments.length === 0)) return false
    const clientMessageId = createClientId("msg")
    const messageText = content.trim() || tNew("attachmentOnlyPrompt")
    requestScrollToEnd()
    const optimisticMessage = buildOptimisticUserMessage({
      sessionId: session.id,
      clientMessageId,
      text: messageText,
      attachments,
      items: state?.items ?? [],
      nextSeq: state?.nextSeq ?? nextSeqRef.current,
    })
    addOptimisticMessage({
      clientMessageId,
      sessionId: session.id,
      item: optimisticMessage,
    })
    setState((current) => {
      if (!current) return current
      return {
        ...current,
        items: mergeTimelineItems(current.items, [optimisticMessage]),
      }
    })
    requestScrollToEnd()
    setSending(true)
    try {
      const files = attachments.map((attachment) => attachment.file)
      const upload = files.length > 0
        ? await dashboardApi.uploadSessionAttachments(token, session.id, files)
        : null
      await dashboardApi.sendSessionMessage(token, session.id, messageText, {
        attachments: upload?.attachments.map((attachment) => ({ fileId: attachment.fileId })) ?? [],
        clientMessageId,
        ...selections,
      })
      await refresh({ scrollToBottom: true })
      requestScrollToEnd()
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : tSession("sendFailed")
      markOptimisticMessageFailed(clientMessageId, message)
      setState((current) => {
        if (!current) return current
        return {
          ...current,
          items: current.items.map((item) =>
            timelineClientMessageId(item) === clientMessageId && isOptimisticTimelineItem(item)
              ? markOptimisticItemFailed(item, message)
              : item,
          ),
        }
      })
      toast.error(err instanceof Error ? err.message : tSession("sendFailed"))
      return false
    } finally {
      setSending(false)
    }
  }

  const handleConfirmTakeover = async () => {
    if (!session) return
    const nextTakeover = pendingTakeover ?? !session.takeover
    setTakeoverBusy(true)
    try {
      const result = nextTakeover
        ? await dashboardApi.enableTakeover(token, session.id)
        : await dashboardApi.disableTakeover(token, session.id)
      setState((current) => current ? { ...current, session: result.session } : current)
      onSessionUpdated?.(result.session)
      setPendingTakeover(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tSession("updateTakeoverFailed"))
    } finally {
      setTakeoverBusy(false)
    }
  }

  const handleInterrupt = async () => {
    if (!session || interrupting) return
    setInterrupting(true)
    try {
      await dashboardApi.interruptSession(token, session.id)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tSession("interruptFailed"))
    } finally {
      setInterrupting(false)
    }
  }

  const handleRespondInteraction = async (noticeId: string, actionId: string) => {
    if (resolvingNoticeId) return
    setResolvingNoticeId(noticeId)
    setResolvingActionId(actionId)
    try {
      if (!session) return
      await dashboardApi.respondInteraction(token, session.id, noticeId, actionId)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tSession("resolveInteractionFailed"))
    } finally {
      setResolvingNoticeId(null)
      setResolvingActionId(null)
    }
  }

  const interactions = React.useMemo(
    () => openInteractions(state?.notices ?? [], session?.id ?? sessionId),
    [session?.id, sessionId, state?.notices],
  )
  const blockingInteractionList = React.useMemo(
    () => blockingInteractions(state?.notices ?? [], session?.id ?? sessionId),
    [session?.id, sessionId, state?.notices],
  )
  const timelineInteractions = React.useMemo(
    () => interactions.filter((notice) => !isSessionBlockingInteraction(notice, session?.id ?? sessionId)),
    [interactions, session?.id, sessionId],
  )
  const interactionByTarget = React.useMemo(
    () => new Map(timelineInteractions.map((notice) => [noticeTimelineTargetId(notice), notice])),
    [timelineInteractions],
  )
  const detachedInteractions = timelineInteractions.filter((notice) => !noticeTimelineTargetId(notice))
  const detachedNotifications = React.useMemo(
    () => openNotifications(state?.notices ?? []),
    [state?.notices],
  )
  const blockingInteractionCount = blockingInteractionList.length
  const interactionTargetIds = React.useMemo(
    () => new Set(timelineInteractions.map(noticeTimelineTargetId).filter((id): id is string => Boolean(id))),
    [timelineInteractions],
  )
  const timelineGroups = React.useMemo(
    () => groupTimelineItems(state?.items ?? [], interactionTargetIds),
    [interactionTargetIds, state?.items],
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
  const takeoverAgent = runtimeLabel(session.runtime)
  const takeoverDescription = (tSession.raw(
    takeoverTarget ? "takeoverEnableDescription" : "takeoverDisableDescription",
  ) as string[]).map((line) => line.replaceAll("{agent}", takeoverAgent))

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
        <MessageScrollerProvider
          autoScroll
          defaultScrollPosition="last-anchor"
          scrollEdgeThreshold={96}
          scrollPreviousItemPeek={72}
        >
          <SessionScrollerCommands
            scrollToEndRequest={scrollToEndRequest}
            onAfterScrollToEnd={pruneTimelineToInitialLimit}
          />
          <MessageScroller>
            <MessageScrollerViewport onScroll={handleTimelineScroll}>
              <MessageScrollerContent
                aria-busy={session.status === "pending" || session.status === "running"}
                className={cn(
                  "mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-3 overflow-hidden px-5 pb-44 pt-20",
                  blockingInteractionCount > 0 && "pb-[30rem]",
                )}
              >
                {state?.hasMore || loadingOlder ? (
                  <MessageScrollerItem messageId={`${session.id}:load-older`}>
                    <div className="flex justify-center py-2 text-muted-foreground">
                      {loadingOlder ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Button type="button" variant="ghost" size="sm" onClick={() => void loadOlderTimeline()}>
                          {tSession("loadOlder")}
                        </Button>
                      )}
                    </div>
                  </MessageScrollerItem>
                ) : null}
                {loading && !state ? (
                  <MessageScrollerItem messageId={`${session.id}:loading`}>
                    <SessionSkeletonInline />
                  </MessageScrollerItem>
                ) : null}
                {state &&
                state.items.length === 0 &&
                detachedInteractions.length === 0 &&
                detachedNotifications.length === 0 &&
                blockingInteractionList.length === 0 ? (
                  <MessageScrollerItem messageId={`${session.id}:empty`}>
                    <p className="py-12 text-center text-sm text-muted-foreground">{tSession("noActivity")}</p>
                  </MessageScrollerItem>
                ) : null}
                {timelineGroups.map((group) =>
                  group.kind === "reconnect" ? (
                    <MessageScrollerItem key={group.key} messageId={group.key}>
                      <ReconnectGroup group={group} />
                    </MessageScrollerItem>
                  ) : group.kind === "tool-run" ? (
                    <MessageScrollerItem key={group.key} messageId={group.key}>
                      <ToolRunGroup
                        group={group}
                        token={token}
                        session={session}
                        interactionByTarget={interactionByTarget}
                        resolvingNoticeId={resolvingNoticeId}
                        resolvingActionId={resolvingActionId}
                        onRespondInteraction={handleRespondInteraction}
                      />
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem
                      key={group.item.id}
                      messageId={group.item.id}
                      scrollAnchor={isUserTimelineMessage(group.item)}
                    >
                      <TimelineEntry
                        token={token}
                        session={session}
                        item={group.item}
                        interaction={interactionByTarget.get(group.item.id)}
                        resolvingNoticeId={resolvingNoticeId}
                        resolvingActionId={resolvingActionId}
                        onRespondInteraction={handleRespondInteraction}
                      />
                    </MessageScrollerItem>
                  ),
                )}
                {detachedInteractions.map((notice) => (
                  <MessageScrollerItem key={notice.noticeId} messageId={notice.noticeId}>
                    <InteractionCard
                      notice={notice}
                      resolvingNoticeId={resolvingNoticeId}
                      resolvingActionId={resolvingActionId}
                      onRespondInteraction={handleRespondInteraction}
                    />
                  </MessageScrollerItem>
                ))}
                {detachedNotifications.map((notice) => (
                  <MessageScrollerItem key={notice.noticeId} messageId={notice.noticeId}>
                    <NotificationCard notice={notice} />
                  </MessageScrollerItem>
                ))}
                {session.status === "pending" || session.status === "running" ? (
                  <MessageScrollerItem messageId={`${session.id}:status:${session.status}`}>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      <span>
                        {session.status === "pending"
                          ? tSession("runtimePending", { runtime: runtimeLabel(session.runtime) })
                          : tSession("runtimeWorking", { runtime: runtimeLabel(session.runtime) })}
                      </span>
                    </div>
                  </MessageScrollerItem>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton
              size="sm"
              className={cn(
                "z-30 h-8 gap-1.5 rounded-full border bg-background/95 px-3 shadow-lg backdrop-blur",
                blockingInteractionCount > 0
                  ? "data-[direction=end]:bottom-[26rem]"
                  : "data-[direction=end]:bottom-36",
              )}
              onClick={() => {
                window.setTimeout(pruneTimelineToInitialLimit, 300)
              }}
            >
              <ArrowDown data-icon="inline-start" />
              {tSession("bottom")}
            </MessageScrollerButton>
          </MessageScroller>
        </MessageScrollerProvider>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 overflow-hidden">
        <div className="absolute inset-x-0 bottom-0 h-36 bg-linear-to-t from-background/80 to-background/0" />
        {COMPOSER_BLUR_LAYERS.map((layer) => (
          <div key={layer.key} className={layer.className} style={layer.style} />
        ))}
        <BlockingInteractionStack
          notices={blockingInteractionList}
          resolvingNoticeId={resolvingNoticeId}
          resolvingActionId={resolvingActionId}
          onRespondInteraction={handleRespondInteraction}
        />
        <div className="pointer-events-auto relative">
          <SessionComposer
            session={session}
            pendingInteractionCount={blockingInteractionCount}
            creatingSession={isLocalOptimisticSession}
            sending={sending}
            interrupting={interrupting}
            takeoverBusy={takeoverBusy}
            value={composerDraft}
            runtimeSettings={runtimeSettings}
            modelCatalog={state?.catalogs.model ?? null}
            permissionCatalog={state?.catalogs.permission ?? null}
            onValueChange={setComposerDraft}
            onSend={handleSend}
            onInterrupt={handleInterrupt}
            onToggleTakeover={() => setPendingTakeover(!session.takeover)}
          />
        </div>
      </div>
      <Dialog
        open={pendingTakeover !== null}
        onOpenChange={(open: boolean) => {
          if (!open && !takeoverBusy) setPendingTakeover(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {takeoverTarget ? tSession("takeoverEnableTitle") : tSession("takeoverDisableTitle")}
            </DialogTitle>
            <DialogDescription asChild>
              <ul className="list-disc space-y-1 pl-5">
                {takeoverDescription.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
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

function BlockingInteractionStack({
  notices,
  resolvingNoticeId,
  resolvingActionId,
  onRespondInteraction,
}: {
  notices: Notice[]
  resolvingNoticeId: string | null
  resolvingActionId: string | null
  onRespondInteraction: (noticeId: string, actionId: string) => void
}) {
  if (notices.length === 0) return null

  const activeNotice = notices[0]!
  const backingNotices = notices.slice(1, 4).reverse()

  return (
    <div className="pointer-events-auto mx-auto w-full max-w-3xl px-4 pb-1">
      <div className={cn("relative", backingNotices.length > 0 && "pt-4")}>
        {backingNotices.map((notice, index) => {
          const depth = backingNotices.length - index
          return (
            <div
              key={notice.noticeId}
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 top-4 h-16 origin-top rounded-xl border bg-card shadow-sm",
                notice.severity === "error" ? "border-destructive/25" : "border-border/80",
              )}
              style={{
                transform: `translateY(-${depth * 8}px) scale(${1 - depth * 0.014})`,
                opacity: 1 - depth * 0.16,
              }}
            />
          )
        })}
        <div className="relative max-h-[38vh] overflow-y-auto rounded-xl shadow-lg shadow-background/20">
          <InteractionCard
            notice={activeNotice}
            resolvingNoticeId={resolvingNoticeId}
            resolvingActionId={resolvingActionId}
            onRespondInteraction={onRespondInteraction}
          />
        </div>
      </div>
    </div>
  )
}

function SessionScrollerCommands({
  scrollToEndRequest,
  onAfterScrollToEnd,
}: {
  scrollToEndRequest: number
  onAfterScrollToEnd: () => void
}) {
  const { scrollToEnd } = useMessageScroller()
  const lastHandledRequestRef = React.useRef(scrollToEndRequest)

  React.useEffect(() => {
    if (scrollToEndRequest === lastHandledRequestRef.current) return
    lastHandledRequestRef.current = scrollToEndRequest
    const didScroll = scrollToEnd({ behavior: "smooth" })
    if (!didScroll) return
    const timer = window.setTimeout(onAfterScrollToEnd, 300)
    return () => window.clearTimeout(timer)
  }, [onAfterScrollToEnd, scrollToEnd, scrollToEndRequest])

  return null
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

type TimelineReconnectGroup = {
  kind: "reconnect"
  key: string
  items: TimelineItem[]
}

type TimelineGroup = TimelineSingleGroup | TimelineToolRunGroup | TimelineReconnectGroup

function groupTimelineItems(items: TimelineItem[], interactionTargetIds: Set<string>): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  let pendingTools: TimelineItem[] = []
  let pendingReconnects: TimelineItem[] = []

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

  const flushReconnects = () => {
    if (pendingReconnects.length >= 2) {
      groups.push({
        kind: "reconnect",
        key: pendingReconnects.map((item) => item.id).join(":"),
        items: pendingReconnects,
      })
    } else {
      for (const item of pendingReconnects) groups.push({ kind: "single", item })
    }
    pendingReconnects = []
  }

  for (const item of items) {
    if (isReconnectErrorItem(item) && !interactionTargetIds.has(item.id)) {
      flushTools()
      pendingReconnects.push(item)
      continue
    }
    flushReconnects()
    if (isToolRunBarItem(item) && !interactionTargetIds.has(item.id)) {
      pendingTools.push(item)
      continue
    }
    flushTools()
    groups.push({ kind: "single", item })
  }
  flushReconnects()
  flushTools()
  return groups
}

function isReconnectErrorItem(item: TimelineItem): boolean {
  return item.type === "system" && item.status === "failed" && reconnectMessage(item) !== null
}

function isUserTimelineMessage(item: TimelineItem): boolean {
  return item.type === "message" && item.role === "user"
}

function reconnectMessage(item: TimelineItem): string | null {
  const details = recordOf(item.content.details)
  const error = recordOf(details?.error)
  const message =
    textOf(error?.message) ||
    textOf(details?.message) ||
    textOf(item.content.message) ||
    textOf(item.content.text)
  if (!message || !/^Reconnecting\.\.\./.test(message)) return null
  return message
}

function reconnectAttempt(message: string): string | null {
  return message.match(/(\d+\s*\/\s*\d+)/)?.[1]?.replace(/\s+/g, "") ?? null
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isToolRunBarItem(item: TimelineItem): boolean {
  if (item.type === "system" && textOf(item.content.kind) === "reasoning") return true
  if (item.type === "tool") return true
  if (item.type !== "artifact") return false
  return (item.content.kind ?? "artifact") !== "diff"
}

function ReconnectGroup({ group }: { group: TimelineReconnectGroup }) {
  const tSession = useTranslations("dashboard.session")
  const [open, setOpen] = React.useState(false)
  const attempts = group.items
    .map((item) => reconnectMessage(item))
    .filter((message): message is string => Boolean(message))
    .map(reconnectAttempt)
    .filter((attempt): attempt is string => Boolean(attempt))
  const firstAttempt = attempts[0]
  const lastAttempt = attempts[attempts.length - 1]
  const attemptRange = firstAttempt && lastAttempt && firstAttempt !== lastAttempt
    ? `${firstAttempt}–${lastAttempt}`
    : lastAttempt ?? String(group.items.length)
  const title = tSession("reconnectSummary", { count: group.items.length, attempts: attemptRange })

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 max-w-full overflow-hidden">
      <div className="min-w-0 max-w-full space-y-2 overflow-hidden">
        <CollapsibleTrigger asChild>
          <Marker asChild className="w-full">
            <button type="button" className="text-left">
              <ChevronDown className="shrink-0 -rotate-90 transition-transform group-data-[state=open]/marker:rotate-0" />
              <MarkerIcon>
                <WifiOff />
              </MarkerIcon>
              <MarkerContent className="code-mono text-sm">{title}</MarkerContent>
            </button>
          </Marker>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
          <div className="flex flex-col gap-2">
            {group.items.map((item) => (
              <JsonBlock key={item.id} value={item} />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function ToolRunGroup({
  group,
  token,
  session,
  interactionByTarget,
  resolvingNoticeId,
  resolvingActionId,
  onRespondInteraction,
}: {
  group: TimelineToolRunGroup
  token: string
  session: SessionView
  interactionByTarget: Map<string | null, Notice>
  resolvingNoticeId: string | null
  resolvingActionId: string | null
  onRespondInteraction: (noticeId: string, actionId: string) => void
}) {
  const tSession = useTranslations("dashboard.session")
  const [open, setOpen] = React.useState(false)
  const summary = toolRunSummary(group.items, tSession)

	  if (open) {
	    return (
	      <div className="min-w-0 max-w-full space-y-2 overflow-hidden">
	        <Marker asChild className="w-full">
	          <button type="button" className="text-left" onClick={() => setOpen(false)}>
	            <ChevronDown className="shrink-0 transition-transform" />
	            <MarkerContent className="code-mono text-sm">{summary}</MarkerContent>
	          </button>
	        </Marker>
	        {group.items.map((item) => (
          <TimelineEntry
            key={item.id}
            token={token}
            session={session}
            item={item}
            interaction={interactionByTarget.get(item.id)}
            resolvingNoticeId={resolvingNoticeId}
            resolvingActionId={resolvingActionId}
            onRespondInteraction={onRespondInteraction}
          />
        ))}
      </div>
    )
  }

	  return (
	    <Marker asChild className="w-full">
	      <button type="button" className="text-left" onClick={() => setOpen(true)}>
	        <ChevronDown className="shrink-0 -rotate-90 transition-transform" />
	        <MarkerContent className="code-mono text-sm">{summary}</MarkerContent>
	      </button>
	    </Marker>
	  )
	}

function toolRunSummary(
  items: TimelineItem[],
  tSession: (key: string, values?: Record<string, string | number>) => string,
): string {
  let commands = 0
  let createdFiles = 0
  let changedFiles = 0
  let reasoning = 0
  for (const item of items) {
    if (item.type === "system" && textOf(item.content.kind) === "reasoning") {
      reasoning += 1
      continue
    }
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
  if (reasoning > 0) parts.push(tSession("toolSummaryReasoning", { count: reasoning }))
  if (commands > 0) parts.push(tSession("toolSummaryCommands", { count: commands }))
  if (changedFiles > 0) parts.push(tSession("toolSummaryChangedFiles", { count: changedFiles }))
  if (createdFiles > 0) parts.push(tSession("toolSummaryCreatedFiles", { count: createdFiles }))
  return parts.length > 0 ? parts.join(", ") : tSession("toolSummaryItems", { count: items.length })
}

function mergeSessionEvent(
  current: SessionRemoteState | null,
  event: ProtocolEventEnvelope,
): SessionRemoteState | null {
  if (!current) return current

  const session = readPayloadValue<SessionView>(event.payload.session)
  const item = readPayloadValue<TimelineItem>(event.payload.item)
  const notice = readPayloadValue<Notice>(event.payload.notice)
  const effectiveCapabilities = readPayloadValue<ProtocolCapabilitySet>(event.payload.effectiveCapabilities)

  const nextNotices = notice ? mergeNotices(current.notices, [notice]) : current.notices
  const nextItems = item ? mergeTimelineItems(current.items, [item]) : current.items
  const nextSession = session && session.updatedSeq >= current.session.updatedSeq ? session : current.session
  const nextSeq = Math.max(current.nextSeq, event.sequence)

  return {
    ...current,
    session: nextSession,
    items: nextItems,
    notices: nextNotices,
    nextSeq,
    eventCursor: event.sequence >= current.nextSeq ? event.cursor : current.eventCursor,
    effectiveCapabilities: effectiveCapabilities ?? current.effectiveCapabilities,
    serverTime: event.emittedAt ?? current.serverTime,
  }
}

function mergeNotices(current: Notice[], incoming: Notice[]): Notice[] {
  if (incoming.length === 0) return current
  const byId = new Map(current.map((notice) => [notice.noticeId, notice]))
  for (const notice of incoming) {
    const existing = byId.get(notice.noticeId)
    if (!existing || existing.updatedSeq <= notice.updatedSeq) byId.set(notice.noticeId, notice)
  }
  return Array.from(byId.values()).sort((a, b) => a.updatedSeq - b.updatedSeq || a.noticeId.localeCompare(b.noticeId))
}

function parseProtocolEvent(data: string): ProtocolEventEnvelope | null {
  try {
    const event = JSON.parse(data) as Partial<ProtocolEventEnvelope>
    if (!event || typeof event.type !== "string") return null
    if (event.type === "keepalive") return null
    if (typeof event.sessionId !== "string" || typeof event.sequence !== "number" || typeof event.cursor !== "string") {
      return null
    }
    return {
      protocolVersion: event.protocolVersion,
      eventId: event.eventId,
      sequence: event.sequence,
      cursor: event.cursor,
      type: event.type,
      sessionId: event.sessionId,
      emittedAt: event.emittedAt,
      payload: event.payload ?? {},
    }
  } catch {
    return null
  }
}

function cursorSequence(cursor: string | null | undefined): number {
  if (!cursor) return 0
  const raw = cursor.startsWith("seq:") ? cursor.slice(4) : cursor
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

function readPayloadValue<T>(value: unknown): T | null {
  return value && typeof value === "object" ? value as T : null
}

function openInteractions(notices: Notice[], _sessionId?: string): Notice[] {
  return notices.filter((notice) =>
    notice.type === "interaction" && (
      notice.status === "open" ||
      notice.status === "response_accepted" ||
      notice.status === "resolving" ||
      notice.status === "failed"
    ),
  )
}

function openNotifications(notices: Notice[]): Notice[] {
  return notices.filter((notice) => notice.type === "notification" && notice.status === "open")
}

function blockingInteractions(notices: Notice[], sessionId: string): Notice[] {
  return openInteractions(notices).filter((notice) => isSessionBlockingInteraction(notice, sessionId))
}

function isSessionBlockingInteraction(notice: Notice, sessionId: string): boolean {
  return notice.blocking?.scope === "session" && notice.blocking.targetId === sessionId
}

function noticeTimelineTargetId(notice: Notice): string | null {
  const timelineItemId = notice.source.timelineItemId
  if (typeof timelineItemId === "string" && timelineItemId) return timelineItemId
  const contextTimelineItemId = notice.context.timelineItemId
  if (typeof contextTimelineItemId === "string" && contextTimelineItemId) return contextTimelineItemId
  return null
}
