package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeNotice
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession

internal fun reduceRealtimeEvent(
    current: SessionDetailState,
    event: RemoteSessionEventEnvelope,
    devices: List<AgentDevice>,
): SessionDetailState {
    if (event.protocolVersion != "1.0" || event.sessionId != current.session?.id) return current
    if (event.eventId in current.realtime.processedEventIds) return current

    var next = current.copy(realtime = current.realtime.rememberEvent(event.eventId, event.cursor))
    when (event.type) {
        "session.subscribed" -> Unit
        "session.meta.updated" -> event.payload.session?.let { session ->
            val observed = session.toAgentSession(devices.associateBy { it.id })
            val existing = next.session
            if (existing == null || observed.updatedSeq >= existing.updatedSeq) {
                next = next.applyMetaObservation(observed, event.emittedAt)
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
            event.protocolVersion == "1.0" &&
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
            next = reduceRealtimeEvent(next, event, devices)
        }
    }
    flushTimeline()
    return next
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
): SessionDetailState {
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
        messages = mergeReducerOptimistic(mergedReal, live.messages, mergedOrdering),
        orderingItems = mergedOrdering,
        nextSeq = maxOf(snapshot.timeline.nextSeq, live.timeline.nextSeq),
        eventCursor = laterEventCursor(snapshot.timeline.eventCursor, live.timeline.eventCursor),
    )
    val runtime = if (live.runtime.isLoaded && live.runtime.updatedSeq >= snapshot.runtime.updatedSeq) {
        live.runtime
    } else {
        snapshot.runtime
    }
    val capabilities = if (live.capabilities.isLoaded && live.capabilities.revision >= snapshot.capabilities.revision) {
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
    val currentReal = messages.filterNot { it.optimistic }
    val projection = mergeRemoteTimelineItems(
        currentOrdering = timeline.orderingItems,
        currentMessages = currentReal,
        incoming = incoming,
        replace = replace,
    )
    val messages = mergeReducerOptimistic(
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
): SessionDetailState {
    return copy(
        meta = meta.copy(
            session = session,
            serverTime = serverTime,
            isLoading = false,
            errorMessage = null,
        ),
    )
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
    val nextCapabilities = if (!capabilities.isLoaded || observed.revision >= capabilities.revision) {
        observed
    } else {
        capabilities.copy(isLoading = false, errorMessage = null)
    }
    return copy(capabilities = nextCapabilities)
}

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
