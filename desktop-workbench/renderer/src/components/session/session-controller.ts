import { dashboardApi } from "@/features/dashboard/api"
import { isApiError } from "@/lib/api/errors"
import { createClientId } from "@/lib/id"
import { sessionRuntimeId, sessionRuntimeType } from "@/features/dashboard/runtime-instances"
import type { ProtocolEventEnvelope, SessionView, TimelineItem } from "@/features/dashboard/types"
import type { SessionRemoteState } from "./session-state-cache"
import { createSessionEventBuffer } from "./session-event-buffer"
import {
  acceptSessionEventId,
  drainSessionEventBuffer,
  mergeEffectiveCapabilities,
  SessionEventSequenceCursor,
} from "./session-event-state"
import { nextTimelineResetVersion } from "./session-review-history"
import { CAPABILITY, capabilityIsUsable } from "./capabilities"
import {
  cursorSequence,
  isTimelineItem,
  loadInitialSessionState,
  mergeRuntimeState,
  mergeSessionEvent,
  mergeSessionSnapshot,
  parseProtocolEvent,
  readPayloadValue,
  sessionEventCanUpdateState,
} from "./session-remote-state"

type StateUpdate = SessionRemoteState | null | ((current: SessionRemoteState | null) => SessionRemoteState | null)
type RuntimeDomain = "state" | "capabilities" | "notices" | "model" | "permission"
type LiveRead = { before: ProtocolEventEnvelope[]; during: ProtocolEventEnvelope[] }

function runtimeDomain(event: ProtocolEventEnvelope): RuntimeDomain | null {
  if (event.type === "runtime.state.updated") return "state"
  if (event.type === "runtime.capability.updated") return "capabilities"
  if (event.type === "runtime.notice.updated" || event.type === "runtime.notice.snapshot") return "notices"
  if (event.type === "runtime.catalog.updated" &&
      (event.payload.catalogType === "model" || event.payload.catalogType === "permission")) return event.payload.catalogType
  return null
}

export type SessionControllerSnapshot = {
  state: SessionRemoteState | null
  error: string | null
  initialLoadComplete: boolean
  hasSnapshot: boolean
  subscribed: boolean
  recovered: boolean
  runtimeRefreshing: boolean
  recoveryGeneration: number
  invalidated: boolean
  domainEvents: ReadonlyMap<string, ProtocolEventEnvelope>
}

export type SessionControllerOptions = {
  token: string
  sessionId: string
  initialState: SessionRemoteState | null
  hasSnapshot: boolean
  loadFailedMessage?: string
  applyOptimisticItems: (state: SessionRemoteState) => SessionRemoteState
  clearResolvedOptimisticMessages: (sessionId: string, items: TimelineItem[]) => void
  onSessionUpdated?: (session: SessionView) => void
  onInvalidated: () => void
}

/** A detail view's remote state, subscription and incremental recovery. */
export function createSessionController(options: SessionControllerOptions) {
  const { token, sessionId } = options
  let snapshot: SessionControllerSnapshot = {
    state: options.initialState,
    error: null,
    initialLoadComplete: options.hasSnapshot,
    hasSnapshot: options.hasSnapshot,
    subscribed: false,
    recovered: false,
    runtimeRefreshing: false,
    recoveryGeneration: 0,
    invalidated: false,
    domainEvents: new Map(),
  }
  const listeners = new Set<() => void>()
  const errors = new Map<string, string>()
  const cursor = new SessionEventSequenceCursor(sessionId, cursorSequence(options.initialState?.eventCursor))
  let callbacks = options
  let started = false
  let disposed = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let snapshotReady = options.hasSnapshot
  let connection = 0
  let recoveredConnection = 0
  let recoveryPromise: Promise<void> | null = null
  let recoveryStarting = false
  let refetchPromise: Promise<void> | null = null
  let bufferedEvents: ProtocolEventEnvelope[] = []
  let processedIds = new Set<string>()
  const liveReads = new Map<RuntimeDomain, LiveRead>()

  function publish(patch: Partial<SessionControllerSnapshot>) {
    if (disposed) return
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }

  function updateState(update: StateUpdate) {
    if (disposed || snapshot.invalidated) return
    const previous = snapshot.state
    const state = typeof update === "function" ? update(previous) : update
    if (state === previous) return
    publish({ state })
    if (!state || !started || !snapshotReady || !snapshot.subscribed || recoveryPromise || recoveryStarting) return
    if (state.session.connectorStatus !== previous?.session.connectorStatus) {
      if (state.session.connectorStatus === "online") refreshRuntime(true)
      else {
        releaseLiveReads()
        clearError("capabilities")
        clearError("notices")
      }
    } else if (state.effectiveCapabilities !== previous?.effectiveCapabilities) refreshCatalogs(false)
  }

  function recordError(key: string, error: unknown) {
    if (disposed || snapshot.invalidated) return
    if (isApiError(error) && (error.status === 403 || error.status === 404)) {
      callbacks.onInvalidated()
      errors.clear()
      liveReads.clear()
      renderBuffer.clear()
      bufferedEvents = []
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      publish({
        state: null,
        error: error.message,
        invalidated: true,
        hasSnapshot: false,
        initialLoadComplete: true,
        subscribed: false,
        recovered: false,
        runtimeRefreshing: false,
      })
      socket?.close()
      return
    }
    errors.set(key, error instanceof Error ? error.message : (callbacks.loadFailedMessage ?? "Failed to load session"))
    publish({ error: errors.values().next().value ?? null })
  }

  function clearError(key: string) {
    if (!errors.delete(key)) return
    publish({ error: errors.values().next().value ?? null })
  }

  const renderBuffer = createSessionEventBuffer((events) => {
    updateState((current) =>
      events.reduce((next, event) => {
        // Runtime projections have their own read barriers and versions. A
        // later timeline item must not discard a notice received during its read.
        if (next && runtimeDomain(event)) {
          const merged = mergeSessionEvent(next, event)
          // A domain released after its read does not prove that intervening
          // durable timeline events were consumed. Keep their cursor separate.
          return merged ? { ...merged, nextSeq: next.nextSeq, eventCursor: next.eventCursor } : merged
        }
        return next && event.sequence < next.nextSeq ? next : mergeSessionEvent(next, event)
      }, current),
    )
    const items = events.flatMap((event) => {
      const item = readPayloadValue<TimelineItem>(event.payload.item)
      return item ? [item] : Array.isArray(event.payload.items) ? event.payload.items.filter(isTimelineItem) : []
    })
    if (items.length) callbacks.clearResolvedOptimisticMessages(sessionId, items)
  })

  function applyProjection(event: ProtocolEventEnvelope) {
    if (disposed || snapshot.invalidated || event.sessionId !== sessionId) return
    renderBuffer.push(event)
    if (!runtimeDomain(event)) cursor.advance(sessionId, event.sequence)
  }

  function applyEvent(event: ProtocolEventEnvelope) {
    if (disposed || snapshot.invalidated || event.sessionId !== sessionId) return
    if (event.type === "goal.state.updated" || event.type === "planning.state.updated") {
      publish({ domainEvents: new Map(snapshot.domainEvents).set(event.type, event) })
      return
    }
    if (event.type === "keepalive") return
    const domain = runtimeDomain(event)
    const read = domain && liveReads.get(domain)
    if (read) {
      read.during.push(event)
      return
    }
    if ((!domain && !cursor.accepts(sessionId, event.sequence)) || !acceptSessionEventId(event, processedIds)) return
    if (processedIds.size > 1000) processedIds = new Set([...processedIds].slice(-500))
    if (event.type === "session.refetch_required") {
      void recoverEvents()
      return
    }
    if (sessionEventCanUpdateState(event)) applyProjection(event)
    else cursor.advance(sessionId, event.sequence)
  }

  function releaseLiveReads() {
    for (const read of liveReads.values()) {
      for (const event of [...read.before, ...read.during]) applyProjection(event)
    }
    liveReads.clear()
    publish({ runtimeRefreshing: false })
  }

  function startLiveRead<T>(
    domain: RuntimeDomain,
    request: () => Promise<T>,
    merge: (state: SessionRemoteState, result: T, before: ProtocolEventEnvelope[]) => SessionRemoteState,
    onSettled?: () => void,
  ) {
    const read: LiveRead = { before: [], during: [] }
    bufferedEvents = bufferedEvents.filter((event) => {
      if (runtimeDomain(event) !== domain) return true
      read.before.push(event)
      return false
    })
    liveReads.set(domain, read)
    publish({ runtimeRefreshing: true })
    void Promise.resolve()
      .then(request)
      .then(
        (result) => {
          if (disposed || snapshot.invalidated || liveReads.get(domain) !== read) return
          renderBuffer.flush()
          // Flushing a presence event may cancel this read or start a newer one.
          if (disposed || snapshot.invalidated || liveReads.get(domain) !== read) return
          updateState((current) => (current ? merge(current, result, read.before) : current))
          clearError(domain)
        },
        (error) => {
          if (disposed || liveReads.get(domain) !== read) return
          // A Connector can disconnect between the presence check and the RPC.
          if ((domain === "capabilities" || domain === "notices" || domain === "model" || domain === "permission") &&
              isApiError(error) && error.status === 409) clearError(domain)
          else recordError(domain, error)
          for (const event of read.before) applyProjection(event)
        },
      )
      .finally(() => {
        if (disposed || liveReads.get(domain) !== read) return
        liveReads.delete(domain)
        for (const event of read.during) applyProjection(event)
        if (onSettled) {
          renderBuffer.flush()
          onSettled()
        }
        publish({ runtimeRefreshing: liveReads.size > 0 })
      })
  }

  function refreshCatalogs(refreshExisting: boolean) {
    const current = snapshot.state
    if (disposed || snapshot.invalidated || !snapshot.subscribed || current?.session.connectorStatus !== "online") return
    const scope = { runtimeId: sessionRuntimeId(current.session), runtimeType: sessionRuntimeType(current.session) }
    if (capabilityIsUsable(current.effectiveCapabilities, CAPABILITY.modelCatalog, scope) &&
        (refreshExisting || !current.catalogs.model) && !liveReads.has("model"))
      startLiveRead("model", () => dashboardApi.getSessionModelCatalog(token, sessionId), (state, result) => ({
        ...state, catalogs: { ...state.catalogs, model: result.catalog }, serverTime: result.serverTime,
      }))
    if (capabilityIsUsable(current.effectiveCapabilities, CAPABILITY.permissionCatalog, scope) &&
        (refreshExisting || !current.catalogs.permission) && !liveReads.has("permission"))
      startLiveRead("permission", () => dashboardApi.getSessionPermissionCatalog(token, sessionId), (state, result) => ({
        ...state, catalogs: { ...state.catalogs, permission: result.catalog }, serverTime: result.serverTime,
      }))
  }

  function refreshRuntime(refreshExisting = options.hasSnapshot || connection > 1) {
    releaseLiveReads()
    startLiveRead(
      "state",
      () => dashboardApi.getSessionRuntimeState(token, sessionId),
      (current, result, before) => {
        const previous = before.reduce(
          (state, event) => mergeRuntimeState(state, readPayloadValue(event.payload.state), sessionId),
          current.state,
        )
        return {
          ...current,
          state: mergeRuntimeState(previous, result.state, sessionId),
          serverTime: result.serverTime,
        }
      },
    )
    if (snapshot.state?.session.connectorStatus === "online") {
      startLiveRead(
        "capabilities",
        () => dashboardApi.getSessionRuntimeCapabilities(token, sessionId),
        (current, result) => ({
          ...current,
          effectiveCapabilities: mergeEffectiveCapabilities(current.effectiveCapabilities, result.capabilitySet),
          serverTime: result.serverTime,
        }),
        () => refreshCatalogs(refreshExisting),
      )
    } else {
      clearError("capabilities")
      clearError("notices")
      return
    }
    // The first snapshot already read notices. Later reads recover changes
    // missed while disconnected, including time spent in another session.
    if (refreshExisting)
      startLiveRead(
        "notices",
        () => dashboardApi.getSessionRuntimeNotices(token, sessionId),
        (current, result) => ({
          ...current,
          notices: result.notices,
          serverTime: result.serverTime,
        }),
      )
  }

  function drainBufferedEvents() {
    const events = bufferedEvents
    bufferedEvents = []
    bufferedEvents = [...drainSessionEventBuffer(events, applyEvent, () => Boolean(recoveryPromise)), ...bufferedEvents]
  }

  function replaceSnapshot(next: SessionRemoteState, reset: boolean) {
    releaseLiveReads()
    renderBuffer.clear()
    const merged = callbacks.applyOptimisticItems(next)
    callbacks.clearResolvedOptimisticMessages(sessionId, merged.items)
    cursor.replaceFromSnapshot(sessionId, cursorSequence(next.eventCursor) || next.nextSeq)
    processedIds.clear()
    updateState((current) =>
      reset
        ? { ...merged, timelineResetVersion: nextTimelineResetVersion(current?.timelineResetVersion ?? 0, true) }
        : current
          ? mergeSessionSnapshot(current, merged)
          : merged,
    )
    // Completing a load attempt (including failure) is distinct from having
    // an authoritative snapshot that can seed a later visit or transport.
    publish({ hasSnapshot: true })
    clearError("snapshot")
    callbacks.onSessionUpdated?.(next.session)
  }

  function refetch(reason: string) {
    if (refetchPromise) return refetchPromise
    refetchPromise = loadInitialSessionState(token, sessionId, { reason })
      .then((next) => {
        if (!disposed && !snapshot.invalidated) replaceSnapshot(next, true)
      })
      .catch((error) => recordError("snapshot", error))
      .finally(() => {
        refetchPromise = null
      })
    return refetchPromise
  }

  function recoverEvents(): Promise<void> {
    if (recoveryPromise) return recoveryPromise
    if (recoveryStarting) return Promise.resolve()
    if (disposed || snapshot.invalidated || !snapshotReady || !snapshot.subscribed) return Promise.resolve()
    recoveryStarting = true
    // Projections queued before the request precede the recovered projection,
    // including when both carry the same durable sequence. Refetch signals
    // in this drain join the recovery instead of recursively starting one.
    const previous = bufferedEvents
    bufferedEvents = []
    drainSessionEventBuffer(previous, applyEvent)
    const recoveringConnection = connection
    publish({ recovered: false })
    let recovered = false
    // Set the gate before invoking APIs, including synchronous test doubles.
    recoveryPromise = Promise.resolve()
      .then(() => dashboardApi.getSessionEvents(token, sessionId, `seq:${cursor.current(sessionId)}`))
      .then(async (recovery) => {
        if (disposed || recoveringConnection !== connection || snapshot.invalidated) return
        if (recovery.snapshotRequired) {
          await refetch("websocket.recovery:snapshot-required")
          recovered = !errors.has("snapshot")
        } else {
          for (const event of recovery.events) applyEvent(event)
          cursor.advance(sessionId, cursorSequence(recovery.nextCursor))
          renderBuffer.flush()
          refreshRuntime()
          recovered = true
        }
        clearError("recovery")
      })
      .catch(async (error) => {
        if (disposed || recoveringConnection !== connection) return
        if (isApiError(error) && (error.status === 403 || error.status === 404)) recordError("recovery", error)
        else {
          await refetch("websocket.recovery:failed")
          recovered = !errors.has("snapshot")
        }
      })
      .finally(() => {
        recoveryPromise = null
        if (disposed || snapshot.invalidated) return
        drainBufferedEvents()
        renderBuffer.flush()
        if (recovered && recoveringConnection === connection && snapshot.subscribed) {
          const reconnect = connection > 1 && recoveredConnection !== connection
          recoveredConnection = connection
          publish({ recovered: true, recoveryGeneration: snapshot.recoveryGeneration + (reconnect ? 1 : 0) })
        }
      })
    recoveryStarting = false
    return recoveryPromise
  }

  async function recoverAfterSubscription(currentConnection: number) {
    if (recoveryPromise) await recoveryPromise
    if (disposed || snapshot.invalidated || currentConnection !== connection || recoveredConnection === connection)
      return
    await recoverEvents()
  }

  async function connect() {
    if (disposed || snapshot.invalidated) return
    const currentConnection = ++connection
    try {
      const ticket = await dashboardApi.createWsTicket(token, createClientId("web"), sessionId)
      if (disposed || snapshot.invalidated || currentConnection !== connection) return
      const currentSocket = new WebSocket(dashboardApi.sessionWebSocketUrl(sessionId, ticket.ticket))
      socket = currentSocket
      currentSocket.onmessage = (message) => {
        if (disposed || snapshot.invalidated || currentConnection !== connection || typeof message.data !== "string")
          return
        const event = parseProtocolEvent(message.data)
        if (!event || event.sessionId !== sessionId) return
        if (event.type === "session.subscribed") {
          clearError("connection")
          publish({ subscribed: true })
          if (snapshotReady) void recoverAfterSubscription(currentConnection)
        } else if (!snapshotReady || recoveryPromise) bufferedEvents.push(event)
        else applyEvent(event)
      }
      currentSocket.onclose = () => {
        if (disposed || snapshot.invalidated || currentConnection !== connection) return
        releaseLiveReads()
        publish({ subscribed: false, recovered: false })
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          void connect()
        }, 1200)
      }
      currentSocket.onerror = () => currentSocket.close()
    } catch (error) {
      if (disposed || currentConnection !== connection) return
      recordError("connection", error)
      if (!snapshot.invalidated)
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          void connect()
        }, 2000)
    }
  }

  return {
    // Selection writes and their revision guard must survive view changes too:
    // a new send waits for the same in-flight write after navigating back.
    selectionChanges: { revision: 0, writes: new Map<string, Promise<unknown>>() },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    updateState,
    configure(next: SessionControllerOptions) {
      callbacks = next
    },
    start() {
      if (started || disposed) return
      started = true
      void connect()
      if (!snapshotReady)
        void loadInitialSessionState(token, sessionId)
          .then((next) => {
            if (!disposed && !snapshot.invalidated) replaceSnapshot(next, false)
          })
          .catch((error) => recordError("snapshot", error))
          .finally(() => {
            if (disposed) return
            snapshotReady = true
            publish({ initialLoadComplete: true })
            if (snapshot.subscribed) void recoverAfterSubscription(connection)
            else drainBufferedEvents()
          })
    },
    dispose() {
      if (disposed) return
      renderBuffer.flush()
      disposed = true
      renderBuffer.dispose()
      bufferedEvents = []
      liveReads.clear()
      listeners.clear()
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      socket?.close()
    },
  }
}

export type SessionController = ReturnType<typeof createSessionController>
