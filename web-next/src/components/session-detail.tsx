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
import { ScrollArea } from "@/components/ui/scroll-area"
import { createClientId } from "@/lib/id"
import { cn } from "@/lib/utils"
import { dashboardApi } from "@/features/dashboard/api"
import type {
  Notice,
  ProtocolCapabilitySet,
  ProtocolEventEnvelope,
  ProtocolModelCatalog,
  ProtocolPermissionCatalog,
  RuntimeCommand,
  RuntimeStatusValue,
  SessionSnapshotResponse,
  SessionRuntimeState,
  SessionView,
  TimelineItem,
} from "@/features/dashboard/types"
import { useTranslations } from "next-intl"
import { InteractionCard, NotificationCard } from "@/components/session/session-approval-card"
import { SessionSkeleton, SessionSkeletonInline } from "@/components/session/session-skeleton"
import { TimelineEntry } from "@/components/session/session-timeline-entry"
import {
  isCreatedFileChange,
  JsonBlock,
  timelineItemStatusIsActive,
  timelineItemStatusIsFailure,
  ToolMarkerRowContent,
} from "@/components/session/session-tool-cards"
import { CAPABILITY, capabilityIsUsable } from "@/components/session/capabilities"
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
  state?: SessionRuntimeState | null
  items: TimelineItem[]
  notices: Notice[]
  nextSeq: number
  hasMore: boolean
  serverTime: string
  pendingInteractionCount: number
}

type SessionRemoteState = {
  session: SessionView
  state?: SessionRuntimeState | null
  items: TimelineItem[]
  notices: Notice[]
  nextSeq: number
  hasMore: boolean
  serverTime: string
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
const AUTO_SCROLL_BOTTOM_DISTANCE = 180
const INITIAL_SCROLL_LAYOUT_QUIET_MS = 120
const INITIAL_SCROLL_LAYOUT_FALLBACK_MS = 900
const INITIAL_SCROLL_ANIMATION_OFFSET_PX = 280
const SCROLL_TO_BOTTOM_INTERVAL_MS = 1000
const SCROLL_TO_BOTTOM_PRUNE_CHECK_MS = 120
const COMMAND_QUERY_DEBOUNCE_MS = 120
const COMPOSER_DRAFT_STORAGE_PREFIX = "agents-anywhere.sessionComposerDraft.v1."
type ComposerDraftState = {
  sessionId: string
  value: string
}

async function loadInitialSessionState(
  token: string,
  sessionId: string,
  options: { reason?: string } = {},
): Promise<SessionRemoteState> {
  const snapshot = await dashboardApi.getSessionSnapshot(token, sessionId, INITIAL_TIMELINE_LIMIT, {
    reason: options.reason ?? "session-detail.initial-load",
  })
  const state = sessionStateFromSnapshot(snapshot)
  try {
    const capabilities = await dashboardApi.getSessionRuntimeCapabilities(token, sessionId)
    return {
      ...state,
      effectiveCapabilities: capabilities.capabilitySet,
    }
  } catch {
    return state
  }
}

function sessionStateFromSnapshot(snapshot: SessionSnapshotResponse): SessionRemoteState {
  return {
    session: snapshot.session,
    state: snapshot.state ?? null,
    items: sortTimelineItems(snapshot.timeline.items),
    notices: snapshot.notices,
    nextSeq: snapshot.timeline.nextSeq,
    hasMore: snapshot.timeline.hasMore,
    serverTime: snapshot.serverTime,
    eventCursor: snapshot.eventCursor,
    effectiveCapabilities: snapshot.effectiveCapabilities,
    catalogs: {},
  }
}

function nextOptimisticRuntimeState(
  state: SessionRuntimeState | null | undefined,
  session: SessionView,
  status: SessionRuntimeState["status"],
): SessionRuntimeState {
  const now = new Date().toISOString()
  return {
    sessionId: session.id,
    runtime: session.runtime,
    externalSessionId: session.externalSessionId,
    status,
    selections: state?.selections ?? {},
    statusReason: state?.statusReason ?? null,
    error: state?.error ?? null,
    metadata: state?.metadata ?? {},
    updatedSeq: state?.updatedSeq ?? session.updatedSeq,
    createdAt: state?.createdAt ?? now,
    updatedAt: now,
  }
}

function selectionPatchFromComposerSelections(
  current: Record<string, string | null>,
  selections: { model?: string; permission?: string },
): Record<string, string | null> {
  const patch: Record<string, string | null> = {}
  if (selections.model && selections.model !== current.model) {
    patch.model = selections.model
  }
  if (selections.permission && selections.permission !== current.permission) {
    patch.permission = selections.permission
  }
  return patch
}

function runtimeStateWithSelections(
  state: SessionRuntimeState | null | undefined,
  session: SessionView,
  selections: Record<string, string | null>,
): SessionRuntimeState {
  const nextState = nextOptimisticRuntimeState(state, session, state?.status ?? "idle")
  return {
    ...nextState,
    selections: {
      ...nextState.selections,
      ...selections,
    },
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
  } = useWorkspace()
  const [state, setState] = React.useState<SessionRemoteState | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const [interrupting, setInterrupting] = React.useState(false)
  const [takeoverBusy, setTakeoverBusy] = React.useState(false)
  const [resolvingNoticeId, setResolvingNoticeId] = React.useState<string | null>(null)
  const [resolvingActionId, setResolvingActionId] = React.useState<string | null>(null)
  const [showScrollBottom, setShowScrollBottom] = React.useState(false)
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  const [pendingTakeover, setPendingTakeover] = React.useState<boolean | null>(null)
  const [commandQuery, setCommandQuery] = React.useState<string | null>(null)
  const [runtimeCommands, setRuntimeCommands] = React.useState<RuntimeCommand[]>([])
  const [commandsLoading, setCommandsLoading] = React.useState(false)
  const [blockingInteractionStackHeight, setBlockingInteractionStackHeight] = React.useState(0)
  const [timelineGroupOpenByKey, setTimelineGroupOpenByKey] = React.useState<Record<string, boolean>>({})
  const [timelineItemOpenById, setTimelineItemOpenById] = React.useState<Record<string, boolean>>({})
  const [composerDraftState, setComposerDraftState] = React.useState<ComposerDraftState>(() => ({
    sessionId,
    value: readComposerDraft(sessionId),
  }))
  const timelineRef = React.useRef<HTMLDivElement | null>(null)
  const timelineContentRef = React.useRef<HTMLDivElement | null>(null)
  const nextSeqRef = React.useRef(0)
  const autoScrollOnNextUpdateRef = React.useRef(false)
  const forceScrollOnNextUpdateRef = React.useRef(false)
  const initialScrollDoneRef = React.useRef(false)
  const loadingOlderRef = React.useRef(false)
  const pendingPrependScrollRestoreRef = React.useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const lastScrollToBottomAtRef = React.useRef(0)
  const scrollToBottomTimerRef = React.useRef<number | null>(null)
  const initialScrollFrameRef = React.useRef<number | null>(null)
  const initialScrollQuietTimerRef = React.useRef<number | null>(null)
  const initialScrollFallbackTimerRef = React.useRef<number | null>(null)
  const pruneAfterScrollTimerRef = React.useRef<number | null>(null)
  const streamConnectedRef = React.useRef(false)
  const processedEventIdsRef = React.useRef<Set<string>>(new Set())
  const selectionUpdateSeqRef = React.useRef(0)

  const session = state?.session ?? fallbackSession
  const runtimeState = state?.state ?? null
  const runtimeStatus = effectiveRuntimeStatus(runtimeState, session)
  const commandSessionId = session?.id ?? null
  const composerDraft = composerDraftState.sessionId === sessionId ? composerDraftState.value : ""
  const isLocalOptimisticSession = isOptimisticSession(sessionId)
  const hasInitialSessionState = state !== null
  const handleCommandQueryChange = React.useCallback((query: string | null) => {
    setCommandQuery(query)
  }, [])
  const handleTimelineGroupOpenChange = React.useCallback((key: string, open: boolean) => {
    setTimelineGroupOpenByKey((current) => {
      if (current[key] === open) return current
      return { ...current, [key]: open }
    })
  }, [])
  const handleTimelineItemOpenChange = React.useCallback((itemId: string, open: boolean) => {
    setTimelineItemOpenById((current) => {
      if (current[itemId] === open) return current
      return { ...current, [itemId]: open }
    })
  }, [])

  const handleSelectionChange = async (
    selections: { model?: string; permission?: string },
  ): Promise<boolean> => {
    if (!session) return false
    const selectionPatch = selectionPatchFromComposerSelections(state?.state?.selections ?? {}, selections)
    if (Object.keys(selectionPatch).length === 0) return true

    const previousRuntimeState = state?.state ?? null
    const selectionUpdateSeq = selectionUpdateSeqRef.current + 1
    selectionUpdateSeqRef.current = selectionUpdateSeq
    setState((current) =>
      current
        ? {
            ...current,
            state: runtimeStateWithSelections(current.state, current.session, selectionPatch),
          }
        : current,
    )
    try {
      const result = await dashboardApi.updateSessionSelections(token, session.id, selectionPatch)
      if (selectionUpdateSeqRef.current !== selectionUpdateSeq) return true
      setState((current) =>
        current
          ? {
              ...current,
              state: result.state ?? runtimeStateWithSelections(current.state, current.session, selectionPatch),
            }
          : current,
      )
      return true
    } catch (err) {
      if (selectionUpdateSeqRef.current === selectionUpdateSeq) {
        setState((current) => current ? { ...current, state: previousRuntimeState } : current)
      }
      toast.error(err instanceof Error ? err.message : tSession("updateSelectionsFailed"))
      return false
    }
  }

  const applyOptimisticItems = React.useCallback((next: SessionRemoteState): SessionRemoteState => ({
    ...next,
    items: preserveOptimisticItems(next.items, getOptimisticItems(sessionId)),
  }), [getOptimisticItems, sessionId])
  const applyOptimisticItemsRef = React.useRef(applyOptimisticItems)
  const clearResolvedOptimisticMessagesRef = React.useRef(clearResolvedOptimisticMessages)
  const getOptimisticSessionStateRef = React.useRef(getOptimisticSessionState)
  const markAutoScrollIfNearBottomRef = React.useRef<() => void>(() => undefined)
  const onSessionUpdatedRef = React.useRef(onSessionUpdated)
  const tSessionRef = React.useRef(tSession)

  React.useEffect(() => {
    applyOptimisticItemsRef.current = applyOptimisticItems
    clearResolvedOptimisticMessagesRef.current = clearResolvedOptimisticMessages
    getOptimisticSessionStateRef.current = getOptimisticSessionState
    onSessionUpdatedRef.current = onSessionUpdated
    tSessionRef.current = tSession
  }, [applyOptimisticItems, clearResolvedOptimisticMessages, getOptimisticSessionState, onSessionUpdated, tSession])

  React.useEffect(() => {
    setTimelineGroupOpenByKey({})
    setTimelineItemOpenById({})
  }, [sessionId])

  React.useEffect(() => {
    const commandMenuOpen = commandQuery !== null
    if (!commandMenuOpen || !commandSessionId) {
      setRuntimeCommands([])
      setCommandsLoading(false)
      return
    }
    let cancelled = false
    setCommandsLoading(true)
    const timer = window.setTimeout(() => {
      void dashboardApi.getSessionCommands(token, commandSessionId).then((response) => {
        if (cancelled) return
        setRuntimeCommands(response.commands)
      }).catch(() => {
        if (cancelled) return
        setRuntimeCommands([])
      }).finally(() => {
        if (cancelled) return
        setCommandsLoading(false)
      })
    }, COMMAND_QUERY_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [commandQuery !== null, commandSessionId, token])

  React.useEffect(() => {
    const runtime = session?.runtime
    const capabilitySet = state?.effectiveCapabilities ?? null
    if (!runtime || !capabilitySet) return

    const canUseModelCatalog = capabilityIsUsable(
      capabilitySet,
      CAPABILITY.modelCatalog,
      runtime,
    )
    const canUsePermissionCatalog = capabilityIsUsable(
      capabilitySet,
      CAPABILITY.permissionCatalog,
      runtime,
    )
    if (!canUseModelCatalog && !canUsePermissionCatalog) return

    let cancelled = false
    void Promise.all([
      canUseModelCatalog
        ? dashboardApi.getSessionModelCatalog(token, sessionId)
        : Promise.resolve(null),
      canUsePermissionCatalog
        ? dashboardApi.getSessionPermissionCatalog(token, sessionId)
        : Promise.resolve(null),
    ])
      .then(([modelCatalogResponse, permissionCatalogResponse]) => {
        if (cancelled) return
        setState((current) => {
          if (!current || current.session.id !== sessionId) return current
          return {
            ...current,
            catalogs: {
              ...current.catalogs,
              ...(modelCatalogResponse ? { model: modelCatalogResponse.catalog } : {}),
              ...(permissionCatalogResponse
                ? { permission: permissionCatalogResponse.catalog }
                : {}),
            },
          }
        })
      })
      .catch(() => {
        if (cancelled || process.env.NODE_ENV === "production") return
        console.debug("[AgentsAnywhere] session catalog refresh failed", {
          sessionId,
          runtime,
        })
      })

    return () => {
      cancelled = true
    }
  }, [
    session?.runtime,
    sessionId,
    state?.effectiveCapabilities?.revision,
    token,
  ])

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
    setState((current) => {
      if (!current) return current
      const serverItems = current.items.filter((item) => !isOptimisticTimelineItem(item))
      return { ...current, items: preserveOptimisticItems(serverItems, optimisticItems) }
    })
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
      state: state.state ?? null,
      items: state.items,
      notices: state.notices,
      nextSeq: state.nextSeq,
      hasMore: state.hasMore,
      serverTime: state.serverTime,
      pendingInteractionCount: blockingInteractions(state.notices, state.session.id).length,
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

  React.useEffect(() => {
    markAutoScrollIfNearBottomRef.current = markAutoScrollIfNearBottom
  }, [markAutoScrollIfNearBottom])

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
      if (initialScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(initialScrollFrameRef.current)
      }
      if (initialScrollQuietTimerRef.current !== null) {
        window.clearTimeout(initialScrollQuietTimerRef.current)
      }
      if (initialScrollFallbackTimerRef.current !== null) {
        window.clearTimeout(initialScrollFallbackTimerRef.current)
      }
      if (pruneAfterScrollTimerRef.current !== null) {
        window.clearTimeout(pruneAfterScrollTimerRef.current)
      }
    }
  }, [])

  const loadOlderTimeline = React.useCallback(async () => {
    if (loadingOlderRef.current || loadingOlder || !state?.hasMore) return
    const oldestItem = state.items[0]
    if (!oldestItem) return

    const viewport = timelineRef.current
    const previousScrollHeight = viewport?.scrollHeight ?? 0
    const previousScrollTop = viewport?.scrollTop ?? 0

    loadingOlderRef.current = true
    setLoadingOlder(true)
    try {
      const older = await dashboardApi.getSessionTimelineBefore(
        token,
        sessionId,
        oldestItem.orderSeq,
        TIMELINE_PAGE_LIMIT,
      )
      setState((current) => {
        if (!current) return current
        if (older.items.length === 0) return { ...current, hasMore: older.hasMore, serverTime: older.serverTime }
        const items = mergeTimelineItems(older.items, current.items)
        pendingPrependScrollRestoreRef.current = {
          scrollHeight: previousScrollHeight,
          scrollTop: previousScrollTop,
        }
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

  const handleTimelineScroll = React.useCallback(() => {
    const viewport = timelineRef.current
    updateScrollBottomState()
    if (!viewport || viewport.scrollTop > LOAD_OLDER_SCROLL_THRESHOLD) return
    void loadOlderTimeline()
  }, [loadOlderTimeline, updateScrollBottomState])

  React.useEffect(() => {
    initialScrollDoneRef.current = false
    if (initialScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(initialScrollFrameRef.current)
      initialScrollFrameRef.current = null
    }
    if (initialScrollQuietTimerRef.current !== null) {
      window.clearTimeout(initialScrollQuietTimerRef.current)
      initialScrollQuietTimerRef.current = null
    }
    if (initialScrollFallbackTimerRef.current !== null) {
      window.clearTimeout(initialScrollFallbackTimerRef.current)
      initialScrollFallbackTimerRef.current = null
    }
    processedEventIdsRef.current = new Set()
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
    const refetch = (reason: string) => {
      if (refetchPromise) return refetchPromise
      markAutoScrollIfNearBottomRef.current()
      refetchPromise = loadInitialSessionState(token, sessionId, { reason })
        .then((next) => {
          if (cancelled) return
          const merged = applyOptimisticItemsRef.current(next)
          clearResolvedOptimisticMessagesRef.current(sessionId, merged.items)
          nextSeqRef.current = Math.max(nextSeqRef.current, cursorSequence(next.eventCursor) || next.nextSeq)
          setState((current) => current ? { ...merged, items: preserveOptimisticItems(merged.items, current.items) } : merged)
          onSessionUpdatedRef.current?.(next.session)
        })
        .catch(() => undefined)
        .finally(() => {
          refetchPromise = null
        })
      return refetchPromise
    }

    const scheduleRefetch = (reason: string) => {
      if (cancelled || refetchPromise || delayedRefetchTimer !== null) return
      delayedRefetchTimer = window.setTimeout(() => {
        delayedRefetchTimer = null
        void refetch(reason)
      }, 1200)
    }

    const applyEvent = (event: ProtocolEventEnvelope) => {
      if (cancelled || event.sessionId !== sessionId) return
      if (event.type === "keepalive") return
      if (processedEventIdsRef.current.has(event.eventId)) return
      if (event.sequence < nextSeqRef.current) return
      processedEventIdsRef.current.add(event.eventId)
      if (processedEventIdsRef.current.size > 1000) {
        processedEventIdsRef.current = new Set(Array.from(processedEventIdsRef.current).slice(-500))
      }
      if (event.type === "session.refetch_required") {
        void recoverEvents(nextSeqRef.current, "session.refetch_required")
        return
      }
      if (!sessionEventCanUpdateState(event)) {
        nextSeqRef.current = Math.max(nextSeqRef.current, event.sequence)
        return
      }
      markAutoScrollIfNearBottomRef.current()
      setState((current) => {
        if (current && event.sequence < current.nextSeq) return current
        return mergeSessionEvent(current, event)
      })
      const item = readPayloadValue<TimelineItem>(event.payload.item)
      if (item) clearResolvedOptimisticMessagesRef.current(sessionId, [item])
      const items = Array.isArray(event.payload.items)
        ? event.payload.items.filter(isTimelineItem)
        : []
      if (items.length > 0) clearResolvedOptimisticMessagesRef.current(sessionId, items)
      nextSeqRef.current = Math.max(nextSeqRef.current, event.sequence)
    }

    const recoverEvents = async (afterSeq: number, reason: string) => {
      if (recoveryPromise) return recoveryPromise
      try {
        recoveryPromise = dashboardApi.getSessionEvents(token, sessionId, `seq:${afterSeq}`)
          .then((recovery) => {
            if (cancelled) return
            if (recovery.snapshotRequired) {
              scheduleRefetch(`${reason}:snapshot-required`)
              return
            }
            for (const event of recovery.events) applyEvent(event)
            nextSeqRef.current = Math.max(
              nextSeqRef.current,
              cursorSequence(recovery.nextCursor),
            )
          })
          .catch(() => undefined)
          .finally(() => {
            recoveryPromise = null
          })
        return recoveryPromise
      } catch {
        return undefined
      }
    }

    const connect = async () => {
      try {
        const ticket = await dashboardApi.createWsTicket(token, createClientId("web"), sessionId)
        if (cancelled) return
        socket = new WebSocket(dashboardApi.sessionWebSocketUrl(sessionId, ticket.ticket))
        socket.onopen = () => {
          if (!cancelled) streamConnectedRef.current = true
        }
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
          streamConnectedRef.current = false
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null
            void connect()
            void recoverEvents(nextSeqRef.current, "websocket.reconnect")
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
      reason: "session-detail.initial-load",
    })
      .then((next) => {
        if (cancelled) return
        setError(null)
        const merged = applyOptimisticItemsRef.current(next)
        clearResolvedOptimisticMessagesRef.current(sessionId, merged.items)
        setState((current) => current ? { ...merged, items: preserveOptimisticItems(merged.items, current.items) } : merged)
        nextSeqRef.current = cursorSequence(next.eventCursor) || next.nextSeq
        onSessionUpdatedRef.current?.(next.session)
        snapshotReady = true
        const pending = bufferedEvents
        bufferedEvents = []
        for (const event of pending.sort((a, b) => a.sequence - b.sequence)) applyEvent(event)
      })
      .catch((err) => {
        if (!cancelled) {
          snapshotReady = true
          setError(err instanceof Error ? err.message : tSessionRef.current("loadFailed"))
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
      streamConnectedRef.current = false
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      if (delayedRefetchTimer !== null) window.clearTimeout(delayedRefetchTimer)
      socket?.close()
    }
  }, [
    isLocalOptimisticSession,
    sessionId,
    token,
  ])

  const handleSend = async (
    content: string,
    attachments: AttachedFile[],
    selections: { model?: string; permission?: string },
  ): Promise<boolean> => {
    if (!session || (!content.trim() && attachments.length === 0)) return false
    const clientMessageId = createClientId("msg")
    const messageText = content.trim() || tNew("attachmentOnlyPrompt")
    forceScrollOnNextUpdateRef.current = true
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
    const previousRuntimeState = state?.state ?? null
    setState((current) => {
      if (!current) return current
      return {
        ...current,
        state: nextOptimisticRuntimeState(current.state, current.session, "waiting"),
        items: mergeTimelineItems(current.items, [optimisticMessage]),
      }
    })
    setSending(true)
    try {
      const selectionPatch = selectionPatchFromComposerSelections(runtimeState?.selections ?? {}, selections)
      if (Object.keys(selectionPatch).length > 0) {
        const selectionResult = await dashboardApi.updateSessionSelections(token, session.id, selectionPatch)
        setState((current) =>
          current
            ? {
                ...current,
                state: selectionResult.state ?? {
                  ...nextOptimisticRuntimeState(current.state, current.session, current.state?.status ?? runtimeStatus),
                  selections: {
                    ...(current.state?.selections ?? {}),
                    ...selectionPatch,
                  },
                },
              }
            : current,
        )
      }
      const files = attachments.map((attachment) => attachment.file)
      const upload = files.length > 0
        ? await dashboardApi.uploadSessionAttachments(token, session.id, files)
        : null
      await dashboardApi.sendSessionMessage(token, session.id, messageText, {
        attachments: upload?.attachments.map((attachment) => ({ fileId: attachment.fileId })) ?? [],
        clientMessageId,
      })
      scrollToBottomThrottled()
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : tSession("sendFailed")
      markOptimisticMessageFailed(clientMessageId, message)
      setState((current) => {
        if (!current) return current
        return {
          ...current,
          state:
            current.state?.status === "waiting"
              ? previousRuntimeState
              : current.state,
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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tSession("interruptFailed"))
    } finally {
      setInterrupting(false)
    }
  }

  const handleSessionCommand = async (
    command: string,
    options: { args: string[]; raw: string },
  ) => {
    if (!session) return
    try {
      const response = await dashboardApi.sendSessionCommand(
        token,
        session.id,
        command,
        options,
      )
      if (response.session) {
        setState((current) => current ? { ...current, session: response.session! } : current)
        onSessionUpdated?.(response.session)
      }
      if (response.message) {
        toast.message(response.message)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tSession("commandFailed"))
    }
  }

  const removeNoticeFromState = React.useCallback((noticeId: string) => {
    setState((current) => {
      if (!current || !current.notices.some((notice) => notice.noticeId === noticeId)) {
        return current
      }
      return {
        ...current,
        notices: current.notices.filter((notice) => notice.noticeId !== noticeId),
      }
    })
  }, [])

  const handleRespondInteraction = async (noticeId: string, actionId: string) => {
    if (resolvingNoticeId) return
    setResolvingNoticeId(noticeId)
    setResolvingActionId(actionId)
    try {
      if (!session) return
      const response = await dashboardApi.respondInteraction(token, session.id, noticeId, actionId)
      if (response.ok) {
        removeNoticeFromState(noticeId)
        return
      }
      if (rpcErrorRemovesNotice(response.error?.code)) {
        removeNoticeFromState(noticeId)
      }
      toast.error(response.error?.message || tSession("resolveInteractionFailed"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tSession("resolveInteractionFailed"))
    } finally {
      setResolvingNoticeId(null)
      setResolvingActionId(null)
    }
  }

  React.useLayoutEffect(() => {
    const pendingPrependScrollRestore = pendingPrependScrollRestoreRef.current
    if (pendingPrependScrollRestore) {
      pendingPrependScrollRestoreRef.current = null
      const viewport = timelineRef.current
      if (viewport) {
        viewport.scrollTop =
          viewport.scrollHeight - pendingPrependScrollRestore.scrollHeight + pendingPrependScrollRestore.scrollTop
      }
      updateScrollBottomState()
      return
    }
    if (forceScrollOnNextUpdateRef.current || autoScrollOnNextUpdateRef.current) {
      forceScrollOnNextUpdateRef.current = false
      autoScrollOnNextUpdateRef.current = false
      scrollToBottomThrottled()
      return
    }
    updateScrollBottomState()
  }, [runtimeStatus, scrollToBottomThrottled, state?.items.length, state?.notices.length, updateScrollBottomState])

  React.useEffect(() => {
    if (initialScrollDoneRef.current || !hasInitialSessionState) return

    let cancelled = false
    let resizeObserver: ResizeObserver | null = null

    const clearInitialScrollTimers = () => {
      if (initialScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(initialScrollFrameRef.current)
        initialScrollFrameRef.current = null
      }
      if (initialScrollQuietTimerRef.current !== null) {
        window.clearTimeout(initialScrollQuietTimerRef.current)
        initialScrollQuietTimerRef.current = null
      }
      if (initialScrollFallbackTimerRef.current !== null) {
        window.clearTimeout(initialScrollFallbackTimerRef.current)
        initialScrollFallbackTimerRef.current = null
      }
    }

    const scrollNearBottomForInitialAnimation = (viewport: HTMLDivElement) => {
      const bottomScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      viewport.scrollTop = Math.max(0, bottomScrollTop - INITIAL_SCROLL_ANIMATION_OFFSET_PX)
    }

    // Side effects: observes timeline layout, closes the first-screen loading phase,
    // and performs the initial animated scroll once the layout has settled.
    const completeInitialLayout = () => {
      if (cancelled || initialScrollDoneRef.current) return
      const viewport = timelineRef.current
      if (!viewport) return

      initialScrollDoneRef.current = true
      clearInitialScrollTimers()
      resizeObserver?.disconnect()
      resizeObserver = null
      setLoading(false)
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" })
      setShowScrollBottom(false)
    }

    const scheduleCompleteAfterQuietLayout = () => {
      if (cancelled || initialScrollDoneRef.current) return
      if (initialScrollQuietTimerRef.current !== null) {
        window.clearTimeout(initialScrollQuietTimerRef.current)
      }
      initialScrollQuietTimerRef.current = window.setTimeout(() => {
        initialScrollQuietTimerRef.current = null
        completeInitialLayout()
      }, INITIAL_SCROLL_LAYOUT_QUIET_MS)
    }

    initialScrollFrameRef.current = window.requestAnimationFrame(() => {
      initialScrollFrameRef.current = window.requestAnimationFrame(() => {
        initialScrollFrameRef.current = null
        const content = timelineContentRef.current
        const viewport = timelineRef.current
        if (viewport) {
          scrollNearBottomForInitialAnimation(viewport)
          setShowScrollBottom(false)
        }
        if (content) {
          resizeObserver = new ResizeObserver(scheduleCompleteAfterQuietLayout)
          resizeObserver.observe(content)
        }
        scheduleCompleteAfterQuietLayout()
      })
    })
    initialScrollFallbackTimerRef.current = window.setTimeout(
      completeInitialLayout,
      INITIAL_SCROLL_LAYOUT_FALLBACK_MS,
    )

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      clearInitialScrollTimers()
    }
  }, [hasInitialSessionState, sessionId])

  const scrollToBottom = React.useCallback(() => {
    const viewport = timelineRef.current
    const shouldPrune = (state?.items.length ?? 0) > INITIAL_TIMELINE_LIMIT
    if (!viewport) {
      if (shouldPrune) {
        setState((current) =>
          current && current.items.length > INITIAL_TIMELINE_LIMIT
            ? { ...current, items: current.items.slice(-INITIAL_TIMELINE_LIMIT) }
            : current,
        )
      }
      return
    }

    if (pruneAfterScrollTimerRef.current !== null) {
      window.clearTimeout(pruneAfterScrollTimerRef.current)
      pruneAfterScrollTimerRef.current = null
    }

    let settled = false
    const pruneIfAtBottom = () => {
      if (distanceFromBottom() > AUTO_SCROLL_BOTTOM_DISTANCE) return false
      forceScrollOnNextUpdateRef.current = true
      setState((current) =>
        current && current.items.length > INITIAL_TIMELINE_LIMIT
          ? { ...current, items: current.items.slice(-INITIAL_TIMELINE_LIMIT) }
          : current,
      )
      return true
    }
    const cleanup = () => {
      viewport.removeEventListener("scrollend", handleScrollEnd)
      if (pruneAfterScrollTimerRef.current !== null) {
        window.clearTimeout(pruneAfterScrollTimerRef.current)
        pruneAfterScrollTimerRef.current = null
      }
    }
    const finish = () => {
      if (settled) return
      if (shouldPrune && !pruneIfAtBottom()) return
      settled = true
      cleanup()
      if (!shouldPrune) updateScrollBottomState()
    }
    const handleScrollEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      if (shouldPrune && !pruneIfAtBottom()) {
        updateScrollBottomState()
      }
    }
    const scheduleCheck = () => {
      if (settled) return
      pruneAfterScrollTimerRef.current = window.setTimeout(() => {
        pruneAfterScrollTimerRef.current = null
        finish()
        if (!settled) scheduleCheck()
      }, SCROLL_TO_BOTTOM_PRUNE_CHECK_MS)
    }

    if (shouldPrune) {
      viewport.addEventListener("scrollend", handleScrollEnd, { once: true })
      scheduleCheck()
    }
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" })
    setShowScrollBottom(false)
  }, [distanceFromBottom, state?.items.length, updateScrollBottomState])

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
  const timelineBottomPadding = blockingInteractionStackHeight > 0
    ? `calc(11rem + ${blockingInteractionStackHeight}px)`
    : undefined
  const scrollBottomButtonOffset = `calc(9rem + ${blockingInteractionStackHeight}px)`
  const interactionTargetIds = React.useMemo(
    () => new Set(timelineInteractions.map(noticeTimelineTargetId).filter((id): id is string => Boolean(id))),
    [timelineInteractions],
  )

  React.useEffect(() => {
    if (blockingInteractionCount === 0 && blockingInteractionStackHeight !== 0) {
      setBlockingInteractionStackHeight(0)
    }
  }, [blockingInteractionCount, blockingInteractionStackHeight])
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
        <ScrollArea
          viewportRef={timelineRef}
          className="h-full"
          viewportProps={{ onScroll: handleTimelineScroll }}
        >
          <div
            ref={timelineContentRef}
            aria-busy={runtimeStatus === "waiting" || runtimeStatus === "pending" || runtimeStatus === "running"}
            className={cn(
              "mx-auto flex w-full min-w-0 max-w-[calc(48rem+2rem)] flex-col gap-3 overflow-hidden px-4 pb-44 pt-20",
            )}
            style={timelineBottomPadding ? { paddingBottom: timelineBottomPadding } : undefined}
          >
            {loadingOlder ? (
              <div className="flex justify-center py-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : null}
            {loading && !state ? <SessionSkeletonInline /> : null}
            {state &&
            state.items.length === 0 &&
            detachedInteractions.length === 0 &&
            detachedNotifications.length === 0 &&
            blockingInteractionList.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">{tSession("noActivity")}</p>
            ) : null}
            {timelineGroups.map((group) =>
              group.kind === "reconnect" ? (
                <ReconnectGroup
                  key={group.key}
                  group={group}
                  open={timelineGroupOpenByKey[group.key] ?? false}
                  onOpenChange={(open) => handleTimelineGroupOpenChange(group.key, open)}
                />
              ) : group.kind === "tool-run" ? (
                <ToolRunGroup
                  key={group.key}
                  group={group}
                  token={token}
                  session={session}
                  interactionByTarget={interactionByTarget}
                  resolvingNoticeId={resolvingNoticeId}
                  resolvingActionId={resolvingActionId}
                  open={timelineGroupOpenByKey[group.key] ?? false}
                  itemOpenById={timelineItemOpenById}
                  onOpenChange={(open) => handleTimelineGroupOpenChange(group.key, open)}
                  onItemOpenChange={handleTimelineItemOpenChange}
                  onRespondInteraction={handleRespondInteraction}
                />
              ) : (
                <TimelineEntry
                  key={group.item.id}
                  token={token}
                  session={session}
                  item={group.item}
                  interaction={interactionByTarget.get(group.item.id)}
                  resolvingNoticeId={resolvingNoticeId}
                  resolvingActionId={resolvingActionId}
                  toolOpen={timelineItemOpenById[group.item.id] ?? false}
                  onToolOpenChange={(open) => handleTimelineItemOpenChange(group.item.id, open)}
                  onRespondInteraction={handleRespondInteraction}
                />
              ),
            )}
            {detachedInteractions.map((notice) => (
              <InteractionCard
                key={notice.noticeId}
                notice={notice}
                resolvingNoticeId={resolvingNoticeId}
                resolvingActionId={resolvingActionId}
                onRespondInteraction={handleRespondInteraction}
              />
            ))}
            {detachedNotifications.map((notice) => (
              <NotificationCard key={notice.noticeId} notice={notice} />
            ))}
            {runtimeStatus === "waiting" || runtimeStatus === "pending" || runtimeStatus === "running" ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span>
                  {runtimeStatus === "waiting" || runtimeStatus === "pending"
                    ? tSession("runtimePending", { runtime: runtimeLabel(session.runtime) })
                    : tSession("runtimeWorking", { runtime: runtimeLabel(session.runtime) })}
                </span>
              </div>
            ) : null}
          </div>
        </ScrollArea>
        {showScrollBottom ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="absolute left-1/2 z-30 h-8 -translate-x-1/2 gap-1.5 rounded-full border bg-background/95 px-3 shadow-lg backdrop-blur"
            style={{ bottom: scrollBottomButtonOffset }}
            onClick={scrollToBottom}
          >
            <ArrowDown data-icon="inline-start" />
            {tSession("bottom")}
          </Button>
        ) : null}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
        <BlockingInteractionStack
          notices={blockingInteractionList}
          resolvingNoticeId={resolvingNoticeId}
          resolvingActionId={resolvingActionId}
          onHeightChange={setBlockingInteractionStackHeight}
          onRespondInteraction={handleRespondInteraction}
        />
        <div className="pointer-events-auto relative">
          <SessionComposer
            session={session}
            runtimeState={runtimeState}
            pendingInteractionCount={blockingInteractionCount}
            creatingSession={isLocalOptimisticSession}
            sending={sending}
            interrupting={interrupting}
            takeoverBusy={takeoverBusy}
            value={composerDraft}
            effectiveCapabilities={state?.effectiveCapabilities ?? null}
            modelCatalog={state?.catalogs.model ?? null}
            permissionCatalog={state?.catalogs.permission ?? null}
            runtimeCommands={runtimeCommands}
            commandsLoading={commandsLoading}
            onCommandQueryChange={handleCommandQueryChange}
            onValueChange={setComposerDraft}
            onSelectionChange={handleSelectionChange}
            onSend={handleSend}
            onInterrupt={handleInterrupt}
            onCommand={handleSessionCommand}
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
              <ul className="flex list-disc flex-col gap-1 pl-5">
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
  onHeightChange,
  onRespondInteraction,
}: {
  notices: Notice[]
  resolvingNoticeId: string | null
  resolvingActionId: string | null
  onHeightChange: (height: number) => void
  onRespondInteraction: (noticeId: string, actionId: string) => void
}) {
  const stackRef = React.useRef<HTMLDivElement | null>(null)

  React.useLayoutEffect(() => {
    const node = stackRef.current
    if (!node) return

    const publishHeight = () => {
      onHeightChange(Math.ceil(node.getBoundingClientRect().height))
    }

    publishHeight()
    const resizeObserver = new ResizeObserver(publishHeight)
    resizeObserver.observe(node)
    return () => {
      resizeObserver.disconnect()
    }
  }, [onHeightChange, notices.length])

  if (notices.length === 0) return null

  const activeNotice = notices[0]!
  const backingNotices = notices.slice(1, 4).reverse()

  return (
    <div ref={stackRef} className="pointer-events-auto mx-auto w-full max-w-[calc(48rem+2rem)] px-4 pb-1">
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
        key: `tool-run:${pendingTools[0]?.id ?? "unknown"}`,
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
        key: `reconnect:${pendingReconnects[0]?.id ?? "unknown"}`,
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

function ReconnectGroup({
  group,
  open,
  onOpenChange,
}: {
  group: TimelineReconnectGroup
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const tSession = useTranslations("dashboard.session")
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
    <Collapsible open={open} onOpenChange={onOpenChange} className="min-w-0 max-w-full overflow-hidden">
      <div className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden">
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
  open,
  itemOpenById,
  onOpenChange,
  onItemOpenChange,
  onRespondInteraction,
}: {
  group: TimelineToolRunGroup
  token: string
  session: SessionView
  interactionByTarget: Map<string | null, Notice>
  resolvingNoticeId: string | null
  resolvingActionId: string | null
  open: boolean
  itemOpenById: Record<string, boolean>
  onOpenChange: (open: boolean) => void
  onItemOpenChange: (itemId: string, open: boolean) => void
  onRespondInteraction: (noticeId: string, actionId: string) => void
}) {
  const tSession = useTranslations("dashboard.session")
  const summary = toolRunSummary(group.items, tSession)
  const status = toolRunStatus(group.items)

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="min-w-0 max-w-full overflow-hidden">
      <div className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden">
        <CollapsibleTrigger asChild>
          <Marker asChild className="w-full">
            <button type="button" className="text-left">
              <ToolMarkerRowContent
                collapsible
                kind="tool"
                status={status}
                title={summary}
              />
            </button>
          </Marker>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
          <div className="flex flex-col gap-2">
            {group.items.map((item) => (
              <TimelineEntry
                key={item.id}
                token={token}
                session={session}
                item={item}
                interaction={interactionByTarget.get(item.id)}
                resolvingNoticeId={resolvingNoticeId}
                resolvingActionId={resolvingActionId}
                toolOpen={itemOpenById[item.id] ?? false}
                onToolOpenChange={(open) => onItemOpenChange(item.id, open)}
                onRespondInteraction={onRespondInteraction}
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function toolRunStatus(items: TimelineItem[]): TimelineItem["status"] {
  if (items.some((item) => timelineItemStatusIsFailure(item.status))) return "failed"
  if (items.some((item) => timelineItemStatusIsActive(item.status))) return "running"
  return "done"
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

  const session = event.type === "session.meta.updated"
    ? readPayloadValue<SessionView>(event.payload.session)
    : null
  const runtimeState = event.type === "runtime.state.updated"
    ? readPayloadValue<SessionRuntimeState>(event.payload.state)
    : null
  const item = event.type === "timeline.item_created" || event.type === "timeline.item_updated"
    ? readPayloadValue<TimelineItem>(event.payload.item)
    : null
  const timelineSnapshot = event.type === "timeline.snapshot" && Array.isArray(event.payload.items)
    ? event.payload.items.filter(isTimelineItem)
    : null
  const notice = event.type === "runtime.notice.updated"
    ? readPayloadValue<Notice>(event.payload.notice)
    : null
  const noticeSnapshot = event.type === "runtime.notice.snapshot" && Array.isArray(event.payload.notices)
    ? event.payload.notices.filter(isNotice)
    : null
  const capabilitySet = event.type === "runtime.capability.updated"
    ? readPayloadValue<ProtocolCapabilitySet>(event.payload.capabilitySet)
    : null

  const nextNotices = noticeSnapshot
    ? noticeSnapshot
    : notice
      ? mergeNotices(current.notices, [notice])
      : current.notices
  const nextItems = timelineSnapshot
    ? preserveOptimisticItems(timelineSnapshot, current.items)
    : item
      ? mergeTimelineItems(current.items, [item])
      : current.items
  const acceptsSession = Boolean(session && session.updatedSeq >= current.session.updatedSeq)
  const nextSession = acceptsSession && session ? session : current.session
  const acceptsRuntimeState = Boolean(
    runtimeState &&
      runtimeState.sessionId === current.session.id &&
      runtimeState.updatedSeq >= (current.state?.updatedSeq ?? 0),
  )
  const nextRuntimeState = acceptsRuntimeState && runtimeState ? runtimeState : current.state
  const nextEffectiveCapabilities = capabilitySet ?? current.effectiveCapabilities
  const nextSeq = Math.max(current.nextSeq, event.sequence)
  const nextEventCursor = event.sequence >= current.nextSeq ? event.cursor : current.eventCursor

  if (
    nextSession === current.session &&
    nextRuntimeState === current.state &&
    nextItems === current.items &&
    nextNotices === current.notices &&
    nextEffectiveCapabilities === current.effectiveCapabilities &&
    nextSeq === current.nextSeq &&
    nextEventCursor === current.eventCursor
  ) {
    return current
  }

  return {
    ...current,
    session: nextSession,
    state: nextRuntimeState,
    items: nextItems,
    notices: nextNotices,
    nextSeq,
    eventCursor: nextEventCursor,
    effectiveCapabilities: nextEffectiveCapabilities,
    serverTime: event.emittedAt ?? current.serverTime,
  }
}

function sessionEventCanUpdateState(event: ProtocolEventEnvelope): boolean {
  return (
    event.type === "session.meta.updated" ||
    event.type === "runtime.state.updated" ||
    event.type === "runtime.capability.updated" ||
    event.type === "runtime.notice.updated" ||
    event.type === "runtime.notice.snapshot" ||
    event.type === "timeline.item_created" ||
    event.type === "timeline.item_updated" ||
    event.type === "timeline.snapshot"
  )
}

function effectiveRuntimeStatus(
  runtimeState: SessionRuntimeState | null | undefined,
  session: SessionView | null | undefined,
): RuntimeStatusValue {
  if (runtimeState) return runtimeState.status
  if (session?.connectorStatus === "offline") return "disconnected"
  return "idle"
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
    if (
      event.protocolVersion !== "1.0" ||
      typeof event.eventId !== "string" ||
      typeof event.emittedAt !== "string" ||
      typeof event.sessionId !== "string" ||
      typeof event.sequence !== "number" ||
      typeof event.cursor !== "string"
    ) {
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

function isTimelineItem(value: unknown): value is TimelineItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Partial<TimelineItem>
  return typeof item.id === "string" && typeof item.updatedSeq === "number"
}

function isNotice(value: unknown): value is Notice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const notice = value as Partial<Notice>
  return typeof notice.noticeId === "string" && typeof notice.updatedSeq === "number"
}

function openInteractions(notices: Notice[], _sessionId?: string): Notice[] {
  return notices.filter((notice) =>
    notice.type === "interaction" && (
      notice.status === "open" ||
      notice.status === "responding" ||
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

function rpcErrorRemovesNotice(code: string | undefined): boolean {
  return (
    code === "not_found" ||
    code === "notice_not_found" ||
    code === "interaction_not_found" ||
    code === "request_not_found" ||
    code === "approval_not_found"
  )
}

function noticeTimelineTargetId(notice: Notice): string | null {
  const timelineItemId = notice.source.timelineItemId
  if (typeof timelineItemId === "string" && timelineItemId) return timelineItemId
  const contextTimelineItemId = notice.context.timelineItemId
  if (typeof contextTimelineItemId === "string" && contextTimelineItemId) return contextTimelineItemId
  return null
}
