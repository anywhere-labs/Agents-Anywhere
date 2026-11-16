package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ACCEPTED_EVENT_PROTOCOL_VERSIONS
import com.agentsanywhere.app.api.RemoteRuntimeNotice
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.SESSION_CATCHUP_REQUIRED
import com.agentsanywhere.app.api.isPortEventType
import com.agentsanywhere.app.feature.preview.applySessionPortEvent
import com.agentsanywhere.app.feature.sessions.toAgentSession
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession

private val LIVE_PROJECTION_EVENT_TYPES = setOf(
    "session.meta.updated",
    "runtime.state.updated",
    "runtime.capability.updated",
    "runtime.catalog.updated",
)

internal fun reduceRealtimeEvent(
    current: SessionDetailState,
    event: RemoteSessionEventEnvelope,
    devices: List<AgentDevice>,
): SessionDetailState = reduceRealtimeEventUnfrozen(current, event, devices).keepingOfflineCursor(current)

/**
 * While the history is unavailable the cursor is not proven to cover the gap
 * before a live event, so no event may move it; recovery reads past it later.
 */
private fun SessionDetailState.keepingOfflineCursor(before: SessionDetailState): SessionDetailState {
    if (!before.timeline.historyUnavailable || !timeline.historyUnavailable) return this
    if (realtime.cursor == before.realtime.cursor && timeline.nextSeq == before.timeline.nextSeq &&
        timeline.eventCursor == before.timeline.eventCursor) return this
    return copy(
        realtime = realtime.copy(cursor = before.realtime.cursor),
        timeline = timeline.copy(nextSeq = before.timeline.nextSeq, eventCursor = before.timeline.eventCursor),
    )
}

private fun reduceRealtimeEventUnfrozen(
    current: SessionDetailState,
    event: RemoteSessionEventEnvelope,
    devices: List<AgentDevice>,
): SessionDetailState {
    if (isPortEventType(event.type)) {
        // Port reports are live device facts (preview 1.0): they neither advance
        // the recovery cursor nor deduplicate, and only this session's ports count.
        val sessionId = current.session?.id ?: return current
        val ports = applySessionPortEvent(current.listeningPorts, event.type, event.payload, sessionId)
        return if (ports === current.listeningPorts) current else current.copy(listeningPorts = ports)
    }
    if (event.protocolVersion !in ACCEPTED_EVENT_PROTOCOL_VERSIONS || event.sessionId != current.session?.id) return current
    // A request to recover from this client's own cursor; it is not a change and has no position.
    if (event.type == SESSION_CATCHUP_REQUIRED) return current
    if (event.type == "runtime.queue.updated") {
        // The queue orders itself by revision. Its envelope borrows the session's
        // current sequence, so it neither advances the cursor nor deduplicates.
        val observed = event.payload.queue?.takeIf { it.sessionId == event.sessionId } ?: return current
        return current.copy(queue = mergeQueueState(current.queue, observed))
    }
    // Live facts can return to an earlier value without advancing the durable
    // sequence, reusing that value's event ID even across cached visits.
    val durable = event.type !in LIVE_PROJECTION_EVENT_TYPES
    if (durable && event.eventId in current.realtime.processedEventIds) return current

    val realtime = if (durable) current.realtime.rememberEvent(event.eventId, event.cursor)
        else current.realtime.copy(cursor = laterEventCursor(current.realtime.cursor, event.cursor))
    var next = current.copy(realtime = realtime)
    when (event.type) {
        "planning.state.updated" -> event.payload.planning?.let { observed ->
            val previous = next.planning
            if (previous == null || previous.epoch != observed.epoch || observed.revision >= previous.revision) {
                val docs = (previous?.documents.orEmpty() + listOfNotNull(observed.proposal)).distinctBy { it.planId to it.revision }
                next = next.copy(planning = observed.copy(documents = docs, actions = observed.actions ?: previous?.actions))
            }
        }
        "session.subscribed" -> Unit
        "session.meta.updated" -> event.payload.session?.let { session ->
            val observed = session.toAgentSession(devices.associateBy { it.id })
            val existing = next.session
            if (existing == null || observed.updatedSeq >= existing.updatedSeq) {
                next = next.applyMetaObservation(observed, event.emittedAt, session)
            }
        }
        "timeline.item_created", "timeline.item_updated" -> event.payload.item?.let { item ->
            next = next.applyTimelineRealtimeItems(
                incoming = listOf(item),
                replace = false,
                cursor = event.cursor,
            )
        }
        "timeline.snapshot" -> {
            val currentTimelineSequence = next.timeline.eventCursor.removePrefix("seq:").toLongOrNull() ?: 0L
            if (event.sequence >= currentTimelineSequence) {
                next = next.applyTimelineRealtimeItems(
                    incoming = event.payload.items,
                    replace = true,
                    cursor = event.cursor,
                )
            }
        }
        "runtime.state.updated" -> event.payload.state?.let { state ->
            next = next.applyRuntimeObservation(state.toSessionRuntimeState(event.emittedAt))
        }
        "runtime.notice.snapshot" -> if (event.sequence >= next.notices.eventSequence) {
            val observed = next.applyNoticeObservation(
                incoming = event.payload.notices,
                serverTime = event.emittedAt,
                replace = true,
            )
            next = observed.copy(notices = observed.notices.copy(eventSequence = event.sequence))
        }
        "runtime.notice.updated" -> event.payload.notice?.let { notice ->
            val observed = next.applyNoticeObservation(
                incoming = listOf(notice),
                serverTime = event.emittedAt,
                replace = false,
            )
            next = observed.copy(
                notices = observed.notices.copy(eventSequence = maxOf(next.notices.eventSequence, event.sequence)),
            )
        }
        "runtime.capability.updated" -> event.payload.capabilitySet?.let { capabilitySet ->
            next = next.applyCapabilitiesObservation(
                capabilitySet.toEffectiveCapabilities(
                    connectorId = next.session?.connectorId,
                    serverTime = event.emittedAt,
                ),
            )
        }
        "runtime.catalog.updated" -> when (event.payload.catalogType) {
            "model" -> event.payload.modelCatalog?.let { catalog ->
                if (next.catalogs.model == null || catalog.revision >= next.catalogs.model.revision) {
                    next = next.copy(
                        catalogs = next.catalogs.copy(
                            model = catalog,
                            modelLoading = false,
                            modelStale = false,
                            modelErrorMessage = null,
                        ),
                    )
                }
            }
            "permission" -> event.payload.permissionCatalog?.let { catalog ->
                if (next.catalogs.permission == null || catalog.revision >= next.catalogs.permission.revision) {
                    next = next.copy(
                        catalogs = next.catalogs.copy(
                            permission = catalog,
                            permissionLoading = false,
                            permissionStale = false,
                            permissionErrorMessage = null,
                        ),
                    )
                }
            }
        }
    }
    return next
}

internal fun reduceRealtimeEvents(
    current: SessionDetailState,
    events: List<RemoteSessionEventEnvelope>,
    devices: List<AgentDevice>,
): SessionDetailState {
    var next = current
    val pendingTimeline = mutableListOf<RemoteSessionEventEnvelope>()

    fun flushTimeline() {
        if (pendingTimeline.isEmpty()) return
        val seen = mutableSetOf<String>()
        val accepted = pendingTimeline.filter { event ->
            event.protocolVersion in ACCEPTED_EVENT_PROTOCOL_VERSIONS &&
                event.sessionId == next.session?.id &&
                event.eventId !in next.realtime.processedEventIds &&
                seen.add(event.eventId)
        }
        pendingTimeline.clear()
        if (accepted.isEmpty()) return
        var cursor = next.realtime.cursor
        accepted.forEach { event ->
            cursor = laterEventCursor(cursor, event.cursor)
            next = next.copy(realtime = next.realtime.rememberEvent(event.eventId, event.cursor))
        }
        next = next.applyTimelineRealtimeItems(
            incoming = accepted.mapNotNull { it.payload.item },
            replace = false,
            cursor = cursor,
        )
    }

    events.forEach { event ->
        if (event.type == "timeline.item_created" || event.type == "timeline.item_updated") {
            pendingTimeline += event
        } else {
            flushTimeline()
            next = reduceRealtimeEventUnfrozen(next, event, devices)
        }
    }
    flushTimeline()
    return next.keepingOfflineCursor(current)
}

internal fun reduceRuntimeLiveState(
    current: SessionDetailState,
    requestState: SessionDetailState,
    refreshed: SessionDetailState,
): SessionDetailState {
    val runtime = if (current.runtime == requestState.runtime) {
        refreshed.runtime
    } else {
        current.runtime
    }
    val capabilities = if (current.capabilities == requestState.capabilities) {
        refreshed.capabilities
    } else {
        current.capabilities
    }
    val notices = if (current.notices == requestState.notices) {
        refreshed.notices
    } else {
        current.notices
    }
    val modelOwnerUnchanged = current.catalogs.model == requestState.catalogs.model &&
        current.catalogs.modelLoading == requestState.catalogs.modelLoading &&
        current.catalogs.modelStale == requestState.catalogs.modelStale &&
        current.catalogs.modelErrorMessage == requestState.catalogs.modelErrorMessage
    val permissionOwnerUnchanged = current.catalogs.permission == requestState.catalogs.permission &&
        current.catalogs.permissionLoading == requestState.catalogs.permissionLoading &&
        current.catalogs.permissionStale == requestState.catalogs.permissionStale &&
        current.catalogs.permissionErrorMessage == requestState.catalogs.permissionErrorMessage
    val catalogs = current.catalogs.copy(
        model = if (modelOwnerUnchanged) refreshed.catalogs.model else current.catalogs.model,
        modelLoading = if (modelOwnerUnchanged) refreshed.catalogs.modelLoading else current.catalogs.modelLoading,
        modelStale = if (modelOwnerUnchanged) refreshed.catalogs.modelStale else current.catalogs.modelStale,
        modelErrorMessage = if (modelOwnerUnchanged) {
            refreshed.catalogs.modelErrorMessage
        } else {
            current.catalogs.modelErrorMessage
        },
        permission = if (permissionOwnerUnchanged) {
            refreshed.catalogs.permission
        } else {
            current.catalogs.permission
        },
        permissionLoading = if (permissionOwnerUnchanged) {
            refreshed.catalogs.permissionLoading
        } else {
            current.catalogs.permissionLoading
        },
        permissionStale = if (permissionOwnerUnchanged) {
            refreshed.catalogs.permissionStale
        } else {
            current.catalogs.permissionStale
        },
        permissionErrorMessage = if (permissionOwnerUnchanged) {
            refreshed.catalogs.permissionErrorMessage
        } else {
            current.catalogs.permissionErrorMessage
        },
    )
    return current.copy(
        planning = if (current.planning == requestState.planning) refreshed.planning else current.planning,
        runtime = runtime,
        capabilities = capabilities,
        notices = notices,
        catalogs = catalogs,
        commands = current.commands,
    )
}

internal fun reduceSnapshotWithLiveState(
    snapshot: SessionDetailState,
    live: SessionDetailState,
    requestState: SessionDetailState,
    replaceHistory: Boolean = false,
): SessionDetailState {
    if (snapshot.timeline.historyUnavailable) return reduceOfflineSnapshot(snapshot, live, requestState)
    if (replaceHistory && live.initialized) {
        // A required snapshot is authoritative, including after a Server cursor reset.
        // Keep only observations that arrived while this snapshot was in flight.
        val previousMessages = requestState.messages.associateBy { it.id }
        val previousOrdering = requestState.timeline.orderingItems.associateBy { it.id }
        val changedOrdering = live.timeline.orderingItems.filter { previousOrdering[it.id] != it }
        val changedMessages = live.messages.filter { it.optimistic || previousMessages[it.id] != it }
        val previousItems = requestState.timeline.remoteItems
        val changedItems = live.timeline.remoteItems.filter { (id, item) -> previousItems[id] !== item }
        val observed = live.copy(
            meta = if (live.session != requestState.session) live.meta else snapshot.meta,
            timeline = snapshot.timeline.copy(
                historyGeneration = live.timeline.historyGeneration,
                messages = changedMessages,
                orderingItems = changedOrdering,
                remoteItems = changedItems,
                nextSeq = maxOf(snapshot.nextSeq, changedOrdering.maxOfOrNull { it.updatedSeq } ?: 0),
            ),
            runtime = if (live.runtime.copy(isLoading = false, errorMessage = null) !=
                requestState.runtime.copy(isLoading = false, errorMessage = null)) live.runtime else snapshot.runtime,
            notices = if (live.notices.notices != requestState.notices.notices ||
                live.notices.eventSequence != requestState.notices.eventSequence) live.notices else snapshot.notices,
            catalogs = live.catalogs.copy(
                model = if (live.catalogs.model != requestState.catalogs.model) live.catalogs.model else snapshot.catalogs.model,
                permission = if (live.catalogs.permission != requestState.catalogs.permission) live.catalogs.permission else snapshot.catalogs.permission,
            ),
            realtime = live.realtime.copy(
                cursor = if (live.realtime.cursor == requestState.realtime.cursor) snapshot.realtime.cursor
                    else laterEventCursor(snapshot.realtime.cursor, live.realtime.cursor),
                processedEventIds = live.realtime.processedEventIds - requestState.realtime.processedEventIds,
            ),
        )
        return reduceSnapshotWithLiveState(snapshot, observed, requestState)
    }
    if (!live.initialized) {
        return snapshot.copy(
            realtime = mergeRealtimeState(snapshot.realtime, live.realtime),
        )
    }

    val snapshotSession = snapshot.session
    val liveSession = live.session
    val meta = if (liveSession != null &&
        (snapshotSession == null || liveSession.updatedSeq >= snapshotSession.updatedSeq)
    ) live.meta else snapshot.meta
    val mergedOrdering = mergeTimelineOrderingItems(
        snapshot.timeline.orderingItems,
        live.timeline.orderingItems,
    )
    val snapshotReal = snapshot.messages.filterNot { it.optimistic }
    val liveReal = live.messages.filterNot { it.optimistic }
    val mergedReal = mergeTimelineMessages(snapshotReal, liveReal, mergedOrdering)
    val timeline = snapshot.timeline.copy(
        historyGeneration = live.timeline.historyGeneration,
        messages = mergeReducerOptimistic(mergedReal, live.messages, mergedOrdering),
        orderingItems = mergedOrdering,
        remoteItems = snapshot.timeline.remoteItems.mergeRemoteItems(live.timeline.remoteItems.values),
        nextSeq = maxOf(snapshot.timeline.nextSeq, live.timeline.nextSeq),
        eventCursor = laterEventCursor(snapshot.timeline.eventCursor, live.timeline.eventCursor),
    )
    val runtime = if (live.runtime.isLoaded && live.runtime.updatedSeq >= snapshot.runtime.updatedSeq) {
        live.runtime
    } else {
        snapshot.runtime
    }
    // Capability revisions are not comparable (see applyCapabilitiesObservation).
    // Facts observed after the snapshot request started are newer than it.
    val capabilitiesObserved = live.capabilities.withoutRequestStatus() !=
        requestState.capabilities.withoutRequestStatus()
    val capabilities = if (live.capabilities.isLoaded && capabilitiesObserved) {
        live.capabilities
    } else {
        snapshot.capabilities
    }
    val notices = if (live.notices.isLoaded && live.notices.eventSequence >= snapshot.notices.eventSequence) {
        live.notices
    } else {
        snapshot.notices
    }
    val catalogs = snapshot.catalogs.copy(
        model = live.catalogs.model
            ?.takeIf { snapshot.catalogs.model == null || it.revision >= snapshot.catalogs.model.revision }
            ?: snapshot.catalogs.model,
        permission = live.catalogs.permission
            ?.takeIf {
                snapshot.catalogs.permission == null || it.revision >= snapshot.catalogs.permission.revision
            }
            ?: snapshot.catalogs.permission,
    )
    return snapshot.copy(
        queue = mergeQueueState(live.queue, snapshot.queue),
        meta = meta,
        timeline = timeline,
        runtime = runtime,
        capabilities = capabilities,
        notices = notices,
        catalogs = catalogs,
        commands = live.commands,
        realtime = mergeRealtimeState(snapshot.realtime, live.realtime),
        actionError = live.actionError,
        takeoverInFlight = live.takeoverInFlight,
        sending = live.sending || timeline.messages.hasPendingOptimisticSend(),
        interrupting = live.interrupting,
        selectionUpdating = live.selectionUpdating,
        commandExecuting = live.commandExecuting,
        respondingNoticeIds = live.respondingNoticeIds,
        // Ports are never part of a snapshot: the live report stands unless the device went offline.
        listeningPorts = live.listeningPorts,
    ).forgettingPortsWhenOffline()
}

/**
 * The Server keeps no history: an offline snapshot carries metadata only.
 * Loaded content, paging and the recovery cursor survive it; without any, the
 * empty page is not an authoritative base, so the next read is a snapshot.
 */
private fun reduceOfflineSnapshot(
    snapshot: SessionDetailState,
    live: SessionDetailState,
    requestState: SessionDetailState,
): SessionDetailState {
    val hasContent = (live.initialized && !live.timeline.historyBaseMissing) || live.timeline.remoteItems.isNotEmpty()
    val base = if (hasContent) {
        snapshot.copy(timeline = live.timeline.copy(historyUnavailable = false), realtime = live.realtime)
    } else {
        snapshot.copy(
            timeline = snapshot.timeline.copy(
                orderingItems = emptyList(),
                messages = snapshot.messages.filter { it.optimistic },
                remoteItems = emptyMap(),
                nextSeq = 0,
                hasMore = false,
                eventCursor = "seq:0",
                historyUnavailable = false,
            ),
            realtime = snapshot.realtime.copy(cursor = "seq:0"),
        )
    }
    val merged = reduceSnapshotWithLiveState(base, live, requestState)
    return merged.copy(
        timeline = merged.timeline.copy(
            historyUnavailable = true,
            historyBaseMissing = !hasContent,
            hasMore = base.timeline.hasMore,
            loadingOlder = false,
        ),
        // The Server's head is not this client's position: keep its own cursor.
        realtime = merged.realtime.copy(cursor = base.realtime.cursor),
    )
}

private fun mergeRealtimeState(
    snapshot: SessionRealtimeState,
    live: SessionRealtimeState,
): SessionRealtimeState {
    val ids = snapshot.processedEventIds + live.processedEventIds
    return live.copy(
        cursor = laterEventCursor(snapshot.cursor, live.cursor),
        processedEventIds = ids.toList().takeLast(1_000).toSet(),
    )
}

private fun SessionDetailState.applyTimelineRealtimeItems(
    incoming: List<com.agentsanywhere.app.api.RemoteTimelineItem>,
    replace: Boolean,
    cursor: String,
): SessionDetailState {
    val hasOptimistic = messages.any { it.optimistic }
    val currentReal = if (hasOptimistic) messages.filterNot { it.optimistic } else messages
    val projection = mergeRemoteTimelineItems(
        currentOrdering = timeline.orderingItems,
        currentMessages = currentReal,
        incoming = incoming,
        replace = replace,
    )
    val remoteItems = timeline.remoteItems.mergeRemoteItems(incoming, replace)
    val messages = if (!hasOptimistic) projection.messages else mergeReducerOptimistic(
        projection.messages,
        this.messages,
        projection.orderingItems,
    )
    val cursorSequence = cursor.removePrefix("seq:").toLongOrNull()
        ?.coerceAtMost(Int.MAX_VALUE.toLong())
        ?.toInt()
        ?: timeline.nextSeq
    return copy(
        timeline = timeline.copy(
            messages = messages,
            orderingItems = projection.orderingItems,
            remoteItems = remoteItems,
            historyGeneration = timeline.historyGeneration + if (replace) 1 else 0,
            loadingOlder = if (replace) false else timeline.loadingOlder,
            nextSeq = maxOf(timeline.nextSeq, cursorSequence),
            eventCursor = laterEventCursor(timeline.eventCursor, cursor),
            isLoading = false,
            errorMessage = null,
        ),
        sending = messages.hasPendingOptimisticSend(),
    )
}


private fun mergeReducerOptimistic(
    realMessages: List<TimelineMessage>,
    currentMessages: List<TimelineMessage>,
    orderingItems: List<TimelineOrderingItem>,
): List<TimelineMessage> {
    return mergeOptimisticTimelineMessages(
        realMessages = realMessages,
        currentMessages = currentMessages,
        storedMessages = emptyList(),
        orderingItems = orderingItems,
    ).messages
}

internal fun SessionDetailState.applyMetaObservation(
    session: AgentSession,
    serverTime: String?,
    remote: com.agentsanywhere.app.api.RemoteSession? = null,
): SessionDetailState {
    return copy(
        meta = meta.copy(
            session = session,
            remote = remote ?: meta.remote?.takeIf { it.id == session.id },
            serverTime = serverTime,
            isLoading = false,
            errorMessage = null,
        ),
    ).forgettingPortsWhenOffline()
}

internal fun SessionDetailState.applyRuntimeObservation(
    observed: SessionRuntimeState,
): SessionDetailState {
    val nextRuntime = if (!runtime.isLoaded || observed.updatedSeq >= runtime.updatedSeq) {
        observed
    } else {
        runtime.copy(isLoading = false, errorMessage = null)
    }
    return copy(runtime = nextRuntime)
}

internal fun SessionDetailState.applyCapabilitiesObservation(
    observed: EffectiveCapabilities,
): SessionDetailState {
    // Revisions are not comparable across sources: live reads carry the session
    // sequence, stored connector facts a microsecond clock. As on Web and iOS,
    // the latest observation wins; identical facts keep the current object.
    val sameFacts = capabilities.isLoaded &&
        capabilities.capabilities == observed.capabilities &&
        capabilities.connectorId == observed.connectorId
    return copy(capabilities = if (sameFacts) capabilities.withoutRequestStatus() else observed)
}

// Loading and error flags describe a request, not the capability facts.
private fun EffectiveCapabilities.withoutRequestStatus(): EffectiveCapabilities =
    copy(isLoading = false, errorMessage = null)

internal fun SessionDetailState.applyNoticeObservation(
    incoming: List<RemoteRuntimeNotice>,
    serverTime: String?,
    replace: Boolean,
): SessionDetailState {
    return copy(
        notices = RuntimeNotices(
            notices = mergeRuntimeNotices(notices.notices, incoming, replace),
            serverTime = serverTime,
            isLoaded = true,
            eventSequence = notices.eventSequence,
        ),
    )
}
