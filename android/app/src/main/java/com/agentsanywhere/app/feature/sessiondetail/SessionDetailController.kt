package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.AttachmentTransferException
import com.agentsanywhere.app.api.AttachmentTransferFailure
import com.agentsanywhere.app.api.RemoteAttachmentRef
import com.agentsanywhere.app.api.RemoteRuntimeCapability
import com.agentsanywhere.app.api.RemoteRuntimeCapabilitySet
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.RemoteRuntimeModelCatalog
import com.agentsanywhere.app.api.RemoteRuntimeNotice
import com.agentsanywhere.app.api.RemoteRuntimePermissionCatalog
import com.agentsanywhere.app.api.RemoteSession
import com.agentsanywhere.app.api.RemoteSessionRuntimeState
import com.agentsanywhere.app.api.RemoteTimelineItem
import com.agentsanywhere.app.api.RemoteUploadedAttachment
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.UploadFilePart
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.sessions.runtimeLabel
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import kotlin.math.max

private const val INITIAL_TIMELINE_LIMIT = 100
private const val TIMELINE_PAGE_LIMIT = 100

class SessionDetailController(
    private val sessionsApi: SessionsApi,
    private val sessionStore: AuthSessionReader,
) {
    private val optimisticLock = Any()
    private val optimisticMessagesBySession = mutableMapOf<String, List<TimelineMessage>>()

    suspend fun load(
        sessionId: String,
        devices: List<AgentDevice>,
        currentState: SessionDetailState? = null,
    ): Result<SessionDetailState> = loadInitialSnapshot(sessionId, devices, currentState)

    suspend fun loadInitialSnapshot(
        sessionId: String,
        devices: List<AgentDevice>,
        currentState: SessionDetailState? = null,
    ): Result<SessionDetailState> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val snapshot = sessionsApi.getSessionSnapshot(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    sessionId = sessionId,
                    limit = INITIAL_TIMELINE_LIMIT,
                )
                val projection = mergeRemoteTimelineItems(
                    currentOrdering = emptyList(),
                    currentMessages = emptyList(),
                    incoming = snapshot.timeline.items,
                    replace = true,
                )
                val messages = mergeOptimistic(
                    sessionId = sessionId,
                    realMessages = projection.messages,
                    currentMessages = currentState?.messages.orEmpty(),
                    orderingItems = projection.orderingItems,
                )
                SessionDetailState(
                    meta = SessionMeta(
                        session = snapshot.session.toAgentSession(devices.associateBy { it.id }),
                        serverTime = snapshot.serverTime,
                    ),
                    timeline = SessionTimelineState(
                        messages = messages,
                        orderingItems = projection.orderingItems,
                        nextSeq = snapshot.timeline.nextSeq,
                        hasMore = snapshot.timeline.hasMore,
                        eventCursor = snapshot.eventCursor,
                    ),
                    runtime = snapshot.state.toSessionRuntimeState(snapshot.serverTime),
                    capabilities = snapshot.effectiveCapabilities.toEffectiveCapabilities(
                        connectorId = snapshot.session.connectorId,
                        serverTime = snapshot.serverTime,
                    ),
                    runtimeCapabilities = snapshot.runtimeCapabilities.toRuntimeCapabilities(),
                    notices = RuntimeNotices(
                        notices = mergeRuntimeNotices(emptyList(), snapshot.notices, replace = true),
                        serverTime = snapshot.serverTime,
                        isLoaded = true,
                        eventSequence = snapshot.eventCursor.removePrefix("seq:").toLongOrNull() ?: 0L,
                    ),
                    // Snapshot catalogs are compatibility data. Existing-session selectors
                    // always use the live session-scoped catalog endpoints.
                    catalogs = currentState?.catalogs ?: RuntimeCatalogs(),
                    commands = currentState?.commands ?: RuntimeCommands(),
                    realtime = (currentState?.realtime ?: SessionRealtimeState()).copy(
                        cursor = snapshot.eventCursor,
                        recovering = false,
                        lastErrorMessage = null,
                    ),
                    initialized = true,
                    actionError = currentState?.actionError,
                    takeoverInFlight = currentState?.takeoverInFlight ?: false,
                    sending = currentState?.sending ?: messages.hasPendingOptimisticSend(),
                    interrupting = currentState?.interrupting ?: false,
                    selectionUpdating = currentState?.selectionUpdating ?: false,
                    commandExecuting = currentState?.commandExecuting ?: false,
                    respondingNoticeIds = currentState?.respondingNoticeIds.orEmpty(),
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not load messages.", error)
            }
        }
    }

    fun applyRealtimeEvent(
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
                    sessionId = event.sessionId,
                    incoming = listOf(item),
                    replace = false,
                    cursor = event.cursor,
                )
            }
            "timeline.snapshot" -> {
                val currentTimelineSequence = next.timeline.eventCursor.removePrefix("seq:").toLongOrNull() ?: 0L
                if (event.sequence >= currentTimelineSequence) {
                    next = next.applyTimelineRealtimeItems(
                        sessionId = event.sessionId,
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

    fun applyRealtimeEvents(
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
                sessionId = accepted.first().sessionId,
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
                next = applyRealtimeEvent(next, event, devices)
            }
        }
        flushTimeline()
        return next
    }

    fun mergeRuntimeLiveState(
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

    fun mergeSnapshotWithLiveState(
        sessionId: String,
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
            messages = mergeOptimistic(sessionId, mergedReal, live.messages, mergedOrdering),
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
        sessionId: String,
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
        val messages = mergeOptimistic(
            sessionId,
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

    suspend fun refreshDomains(
        sessionId: String,
        devices: List<AgentDevice>,
        current: SessionDetailState,
    ): SessionDetailState = withContext(Dispatchers.IO) {
        val auth = authSession()
        coroutineScope {
            val metaRequest = async {
                runCatching { sessionsApi.getSessionMeta(auth.serverUrl, auth.accessToken, sessionId) }
            }
            val timelineRequest = async {
                runCatching {
                    sessionsApi.getSessionTimelineChanges(
                        auth.serverUrl,
                        auth.accessToken,
                        sessionId,
                        afterSeq = current.timeline.nextSeq,
                        limit = TIMELINE_PAGE_LIMIT,
                    )
                }
            }
            val runtimeRequest = async {
                runCatching { sessionsApi.getSessionRuntimeState(auth.serverUrl, auth.accessToken, sessionId) }
            }
            val capabilitiesRequest = async {
                runCatching { sessionsApi.getSessionRuntimeCapabilities(auth.serverUrl, auth.accessToken, sessionId) }
            }
            val noticesRequest = async {
                runCatching { sessionsApi.getSessionRuntimeNotices(auth.serverUrl, auth.accessToken, sessionId) }
            }

            var next = current
            metaRequest.await().fold(
                onSuccess = { response ->
                    next = next.applyMetaObservation(
                        response.session.toAgentSession(devices.associateBy { it.id }),
                        response.serverTime,
                    )
                },
                onFailure = { error ->
                    next = next.copy(
                        meta = next.meta.copy(isLoading = false, errorMessage = error.userMessage()),
                    )
                },
            )
            timelineRequest.await().fold(
                onSuccess = { page ->
                    val projection = mergeRemoteTimelineItems(
                        currentOrdering = next.timeline.orderingItems,
                        currentMessages = next.messages.filterNot { it.optimistic },
                        incoming = page.items,
                        replace = false,
                    )
                    next = next.copy(
                        timeline = next.timeline.copy(
                            messages = mergeOptimistic(
                                sessionId,
                                projection.messages,
                                next.messages,
                                projection.orderingItems,
                            ),
                            orderingItems = projection.orderingItems,
                            nextSeq = max(next.timeline.nextSeq, page.nextSeq),
                            eventCursor = "seq:${max(next.timeline.nextSeq, page.nextSeq)}",
                            isLoading = false,
                            errorMessage = null,
                        ),
                    )
                },
                onFailure = { error ->
                    next = next.copy(
                        timeline = next.timeline.copy(isLoading = false, errorMessage = error.userMessage()),
                    )
                },
            )
            runtimeRequest.await().fold(
                onSuccess = { response ->
                    val observed = response.state.toSessionRuntimeState(response.serverTime)
                    next = next.applyRuntimeObservation(observed)
                },
                onFailure = { error ->
                    next = next.copy(
                        runtime = next.runtime.copy(isLoading = false, errorMessage = error.userMessage()),
                    )
                },
            )
            capabilitiesRequest.await().fold(
                onSuccess = { response ->
                    val observed = response.capabilitySet.toEffectiveCapabilities(
                        connectorId = response.connectorId,
                        serverTime = response.serverTime,
                    )
                    next = next.applyCapabilitiesObservation(observed)
                },
                onFailure = { error ->
                    next = next.copy(
                        capabilities = next.capabilities.copy(
                            isLoading = false,
                            errorMessage = error.userMessage(),
                        ),
                    )
                },
            )
            noticesRequest.await().fold(
                onSuccess = { response ->
                    next = next.applyNoticeObservation(
                        incoming = response.notices,
                        serverTime = response.serverTime,
                        replace = true,
                    )
                },
                onFailure = { error ->
                    next = next.copy(
                        notices = next.notices.copy(isLoading = false, errorMessage = error.userMessage()),
                    )
                },
            )
            next.copy(initialized = true)
        }
    }

    suspend fun refreshRuntimeLiveDomains(
        sessionId: String,
        current: SessionDetailState,
    ): SessionDetailState = withContext(Dispatchers.IO) {
        val auth = authSession()
        coroutineScope {
            val runtimeRequest = async {
                runCatching { sessionsApi.getSessionRuntimeState(auth.serverUrl, auth.accessToken, sessionId) }
            }
            val capabilitiesRequest = async {
                runCatching { sessionsApi.getSessionRuntimeCapabilities(auth.serverUrl, auth.accessToken, sessionId) }
            }
            val noticesRequest = async {
                runCatching { sessionsApi.getSessionRuntimeNotices(auth.serverUrl, auth.accessToken, sessionId) }
            }
            val modelCatalogRequest = current.catalogs.model?.let {
                async {
                    runCatching {
                        sessionsApi.getSessionRuntimeModelCatalog(
                            auth.serverUrl,
                            auth.accessToken,
                            sessionId,
                        ).catalog
                    }
                }
            }
            val permissionCatalogRequest = current.catalogs.permission?.let {
                async {
                    runCatching {
                        sessionsApi.getSessionRuntimePermissionCatalog(
                            auth.serverUrl,
                            auth.accessToken,
                            sessionId,
                        ).catalog
                    }
                }
            }
            var next = current
            runtimeRequest.await().fold(
                onSuccess = { response ->
                    next = next.applyRuntimeObservation(response.state.toSessionRuntimeState(response.serverTime))
                },
                onFailure = { error ->
                    next = next.copy(runtime = next.runtime.copy(errorMessage = error.userMessage()))
                },
            )
            capabilitiesRequest.await().fold(
                onSuccess = { response ->
                    next = next.applyCapabilitiesObservation(
                        response.capabilitySet.toEffectiveCapabilities(response.connectorId, response.serverTime),
                    )
                },
                onFailure = { error ->
                    next = next.copy(capabilities = next.capabilities.copy(errorMessage = error.userMessage()))
                },
            )
            noticesRequest.await().fold(
                onSuccess = { response ->
                    next = next.applyNoticeObservation(response.notices, response.serverTime, replace = true)
                },
                onFailure = { error ->
                    next = next.copy(notices = next.notices.copy(errorMessage = error.userMessage()))
                },
            )
            modelCatalogRequest?.await()?.fold(
                onSuccess = { catalog ->
                    if (next.catalogs.model?.let { catalog.revision >= it.revision } != false) {
                        next = next.copy(
                            catalogs = next.catalogs.copy(
                                model = catalog,
                                modelLoading = false,
                                modelStale = false,
                                modelErrorMessage = null,
                            ),
                        )
                    }
                },
                onFailure = { error ->
                    next = next.copy(
                        catalogs = next.catalogs.copy(
                            modelLoading = false,
                            modelStale = next.catalogs.model != null,
                            modelErrorMessage = error.userMessage(),
                        ),
                    )
                },
            )
            permissionCatalogRequest?.await()?.fold(
                onSuccess = { catalog ->
                    if (next.catalogs.permission?.let { catalog.revision >= it.revision } != false) {
                        next = next.copy(
                            catalogs = next.catalogs.copy(
                                permission = catalog,
                                permissionLoading = false,
                                permissionStale = false,
                                permissionErrorMessage = null,
                            ),
                        )
                    }
                },
                onFailure = { error ->
                    next = next.copy(
                        catalogs = next.catalogs.copy(
                            permissionLoading = false,
                            permissionStale = next.catalogs.permission != null,
                            permissionErrorMessage = error.userMessage(),
                        ),
                    )
                },
            )
            next
        }
    }

    suspend fun loadOlder(
        sessionId: String,
        beforeOrderSeq: Int,
    ): Result<SessionTimelineState> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val page = sessionsApi.getSessionTimelineHistory(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    sessionId = sessionId,
                    beforeOrderSeq = beforeOrderSeq,
                    limit = TIMELINE_PAGE_LIMIT,
                )
                val projection = mergeRemoteTimelineItems(
                    currentOrdering = emptyList(),
                    currentMessages = emptyList(),
                    incoming = page.items,
                    replace = true,
                )
                SessionTimelineState(
                    messages = projection.messages,
                    orderingItems = projection.orderingItems,
                    nextSeq = page.nextSeq,
                    hasMore = page.hasMore,
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not load older messages.", error)
            }
        }
    }

    suspend fun sendMessage(
        sessionId: String,
        content: String,
        clientMessageId: String,
        attachments: List<UploadFilePart> = emptyList(),
        uploadedAttachments: List<TimelineAttachment> = emptyList(),
    ): Result<SendMessageResult> {
        return performMessageAction(
            sessionId = sessionId,
            content = content,
            clientMessageId = clientMessageId,
            attachments = attachments,
            uploadedAttachments = uploadedAttachments,
            steer = false,
        )
    }

    suspend fun steer(
        sessionId: String,
        content: String,
        clientMessageId: String,
        attachments: List<UploadFilePart> = emptyList(),
        uploadedAttachments: List<TimelineAttachment> = emptyList(),
    ): Result<SendMessageResult> {
        return performMessageAction(
            sessionId = sessionId,
            content = content,
            clientMessageId = clientMessageId,
            attachments = attachments,
            uploadedAttachments = uploadedAttachments,
            steer = true,
        )
    }

    private suspend fun performMessageAction(
        sessionId: String,
        content: String,
        clientMessageId: String,
        attachments: List<UploadFilePart>,
        uploadedAttachments: List<TimelineAttachment>,
        steer: Boolean,
    ): Result<SendMessageResult> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val uploaded = if (uploadedAttachments.isNotEmpty()) {
                    uploadedAttachments
                } else if (attachments.isEmpty()) {
                    emptyList()
                } else {
                    uploadAttachmentsWithVerification(auth, sessionId, attachments)
                }
                val response = if (steer) {
                    sessionsApi.steerSession(
                        serverUrl = auth.serverUrl,
                        authorizationToken = auth.accessToken,
                        sessionId = sessionId,
                        content = content,
                        clientMessageId = clientMessageId,
                        attachments = uploaded.map { it.toRemoteAttachmentRef() },
                    )
                } else {
                    sessionsApi.sendSessionMessage(
                        serverUrl = auth.serverUrl,
                        authorizationToken = auth.accessToken,
                        sessionId = sessionId,
                        content = content,
                        clientMessageId = clientMessageId,
                        attachments = uploaded.map { it.toRemoteAttachmentRef() },
                    )
                }
                response.let {
                    SendMessageResult(
                        turnId = it.turnId,
                        attachments = uploaded,
                    )
                }
            }
        }
    }

    suspend fun uploadAttachments(
        sessionId: String,
        attachments: List<UploadFilePart>,
    ): Result<List<TimelineAttachment>> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                uploadAttachmentsWithVerification(auth, sessionId, attachments)
            }
        }
    }

    private fun uploadAttachmentsWithVerification(
        auth: ApiAuth,
        sessionId: String,
        attachments: List<UploadFilePart>,
    ): List<TimelineAttachment> {
        val uploaded = sessionsApi.uploadSessionAttachments(
            serverUrl = auth.serverUrl,
            authorizationToken = auth.accessToken,
            sessionId = sessionId,
            files = attachments,
        )
        if (uploaded.size != attachments.size) {
            throw AttachmentTransferException(AttachmentTransferFailure.IncompleteUpload)
        }
        return uploaded.zip(attachments).map { (remote, local) ->
            val localSha256 = MessageDigest.getInstance("SHA-256")
                .digest(local.bytes)
                .joinToString("") { byte -> "%02x".format(byte) }
            if (remote.size != local.bytes.size.toLong()) {
                throw AttachmentTransferException(AttachmentTransferFailure.SizeMismatch, local.name)
            }
            if (remote.sha256?.lowercase() != localSha256) {
                throw AttachmentTransferException(AttachmentTransferFailure.Sha256Mismatch, local.name)
            }
            remote.toTimelineAttachment()
        }
    }

    suspend fun setTakeover(
        sessionId: String,
        enabled: Boolean,
        devices: List<AgentDevice>,
    ): Result<AgentSession> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val session = if (enabled) {
                    sessionsApi.enableTakeover(auth.serverUrl, auth.accessToken, sessionId)
                } else {
                    sessionsApi.disableTakeover(auth.serverUrl, auth.accessToken, sessionId)
                }
                session.toAgentSession(devices.associateBy { it.id })
            }
        }
    }

    fun attachmentImageRequest(
        sessionId: String,
        attachment: TimelineAttachment,
    ): Result<AttachmentImageRequest> {
        return runCatching {
            val auth = authSession()
            AttachmentImageRequest(
                url = sessionsApi.attachmentOpenUrl(
                    serverUrl = auth.serverUrl,
                    sessionId = sessionId,
                    fileId = attachment.fileId,
                ),
                authorizationToken = auth.accessToken,
                cacheKey = "attachment:$sessionId:${attachment.fileId}",
            )
        }
    }

    suspend fun downloadAttachment(
        sessionId: String,
        attachment: TimelineAttachment,
    ): Result<DownloadedAttachment> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val downloaded = sessionsApi.downloadSessionAttachment(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    sessionId = sessionId,
                    fileId = attachment.fileId,
                )
                DownloadedAttachment(
                    fileId = downloaded.fileId,
                    name = downloaded.name,
                    mediaType = attachment.mediaType,
                    size = downloaded.size,
                    sha256 = downloaded.sha256,
                    bytes = downloaded.bytes,
                )
            }
        }
    }

    suspend fun interrupt(sessionId: String): Result<Unit> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                sessionsApi.interruptSession(auth.serverUrl, auth.accessToken, sessionId)
                Unit
            }
        }
    }

    suspend fun loadSessionModelCatalog(sessionId: String): Result<RemoteRuntimeModelCatalog> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                sessionsApi.getSessionRuntimeModelCatalog(
                    auth.serverUrl,
                    auth.accessToken,
                    sessionId,
                ).catalog
            }
        }
    }

    suspend fun loadSessionPermissionCatalog(sessionId: String): Result<RemoteRuntimePermissionCatalog> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                sessionsApi.getSessionRuntimePermissionCatalog(
                    auth.serverUrl,
                    auth.accessToken,
                    sessionId,
                ).catalog
            }
        }
    }

    suspend fun updateSelections(
        sessionId: String,
        selections: Map<String, String?>,
    ): Result<SessionRuntimeState?> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val response = sessionsApi.patchSessionRuntimeSelections(
                    auth.serverUrl,
                    auth.accessToken,
                    sessionId,
                    selections,
                )
                if (!response.ok) throw IllegalStateException("Runtime rejected the selection update.")
                response.state?.toSessionRuntimeState(response.serverTime)
            }
        }
    }

    suspend fun loadCommands(sessionId: String): Result<List<RuntimeCommand>> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                sessionsApi.getSessionRuntimeCommands(
                    auth.serverUrl,
                    auth.accessToken,
                    sessionId,
                ).commands.map { it.toRuntimeCommand() }
            }
        }
    }

    suspend fun executeCommand(
        sessionId: String,
        command: String,
        args: List<String>,
        raw: String,
    ): Result<CommandExecutionResult> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val response = sessionsApi.executeSessionRuntimeCommand(
                    auth.serverUrl,
                    auth.accessToken,
                    sessionId,
                    command,
                    args,
                    raw,
                )
                if (!response.ok) {
                    throw IllegalStateException(response.message ?: response.code ?: "Command failed.")
                }
                CommandExecutionResult(
                    command = response.command,
                    code = response.code,
                    message = response.message,
                    result = response.result,
                )
            }
        }
    }

    suspend fun respondNotice(
        sessionId: String,
        noticeId: String,
        actionId: String,
        input: Map<String, Any?>?,
    ): Result<Unit> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                sessionsApi.respondRuntimeNotice(
                    auth.serverUrl,
                    auth.accessToken,
                    sessionId,
                    noticeId,
                    actionId,
                    input,
                )
                Unit
            }
        }
    }

    fun applyOlder(
        sessionId: String,
        current: SessionDetailState,
        older: SessionTimelineState,
    ): SessionDetailState {
        val orderingItems = mergeTimelineOrderingItems(
            current.timeline.orderingItems,
            older.orderingItems,
        )
        val realMessages = mergeTimelineMessages(
            current = current.messages.filterNot { it.optimistic },
            incoming = older.messages,
            orderingItems = orderingItems,
        )
        val messages = mergeOptimistic(
            sessionId = sessionId,
            realMessages = realMessages,
            currentMessages = current.messages,
            orderingItems = orderingItems,
        )
        return current.copy(
            timeline = current.timeline.copy(
                messages = messages,
                orderingItems = orderingItems,
                nextSeq = max(current.nextSeq, older.nextSeq),
                hasMore = older.hasMore,
                loadingOlder = false,
                historyErrorMessage = null,
            ),
        )
    }

    fun addOptimisticMessage(
        sessionId: String,
        state: SessionDetailState,
        text: String,
        clientMessageId: String,
        attachments: List<TimelineAttachment> = emptyList(),
        retryAction: RuntimeMessageAction? = null,
    ): SessionDetailState {
        val lastOrderSeq = maxOf(
            state.timeline.orderingItems.maxOfOrNull { it.orderSeq } ?: 0,
            state.messages.maxOfOrNull { it.orderSeq } ?: 0,
        )
        val optimisticOrderSeq = maxOf(lastOrderSeq + 1, state.nextSeq + 1)
        val message = TimelineMessage(
            id = clientMessageId,
            sourceItemId = clientMessageId,
            author = MessageAuthor.User,
            text = text,
            attachments = attachments,
            status = "pending",
            badge = "Sending",
            orderSeq = optimisticOrderSeq,
            updatedSeq = optimisticOrderSeq,
            clientMessageId = clientMessageId,
            turnId = null,
            optimistic = true,
            retryAction = retryAction,
        )
        upsertOptimisticMessage(sessionId, message)
        return state.copy(
            timeline = state.timeline.copy(
                messages = mergeOptimistic(
                    sessionId = sessionId,
                    realMessages = state.messages,
                    currentMessages = state.messages + message,
                    orderingItems = state.timeline.orderingItems,
                ),
            ),
            sending = true,
            actionError = null,
        )
    }

    fun markOptimisticMessage(
        sessionId: String,
        state: SessionDetailState,
        clientMessageId: String,
        status: String,
        turnId: String? = null,
        attachments: List<TimelineAttachment> = emptyList(),
        errorMessage: String? = null,
    ): SessionDetailState {
        val updatedMessages = state.messages.map { message ->
            if (message.id == clientMessageId && message.optimistic) {
                message.copy(
                    status = status,
                    badge = status.statusLabel(),
                    turnId = turnId ?: message.turnId,
                    attachments = attachments.ifEmpty { message.attachments },
                    errorMessage = errorMessage,
                )
            } else {
                message
            }
        }
        replaceOptimisticMessages(
            sessionId = sessionId,
            messages = updatedMessages.filter { it.optimistic },
        )
        return state.copy(
            timeline = state.timeline.copy(
                messages = mergeOptimistic(
                    sessionId = sessionId,
                    realMessages = state.messages,
                    currentMessages = updatedMessages,
                    orderingItems = state.timeline.orderingItems,
                ),
            ),
            sending = status == "pending",
            actionError = if (status == "failed") state.actionError else null,
        )
    }

    fun hasServerEcho(state: SessionDetailState, clientMessageId: String): Boolean {
        return state.messages.any { message ->
            !message.optimistic && message.matchesClientMessage(clientMessageId)
        }
    }

    private fun authSession(): ApiAuth {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) {
            throw IllegalStateException("Sign in again to load this session.")
        }
        return ApiAuth(serverUrl = serverUrl, accessToken = accessToken)
    }

    private fun Throwable.userMessage(): String {
        return message ?: "Could not refresh this session."
    }

    private fun mergeOptimistic(
        sessionId: String,
        realMessages: List<TimelineMessage>,
        currentMessages: List<TimelineMessage>,
        orderingItems: List<TimelineOrderingItem>,
    ): List<TimelineMessage> {
        val real = realMessages.filterNot { it.optimistic }
        val optimistic = (currentMessages.filter { it.optimistic } + optimisticMessages(sessionId))
            .associateBy { it.id }
            .values
            .toList()
        val pending = optimistic.filter { optimisticMessage ->
            real.none { realMessage -> realMessage.matchesClientMessage(optimisticMessage.id) }
        }
        replaceOptimisticMessages(sessionId, pending)
        return sortTimelineMessages(real + pending, orderingItems)
    }

    private fun optimisticMessages(sessionId: String): List<TimelineMessage> {
        return synchronized(optimisticLock) {
            optimisticMessagesBySession[sessionId].orEmpty()
        }
    }

    private fun upsertOptimisticMessage(sessionId: String, message: TimelineMessage) {
        synchronized(optimisticLock) {
            val messages = optimisticMessagesBySession[sessionId].orEmpty()
                .filterNot { it.id == message.id } + message
            optimisticMessagesBySession[sessionId] = sortTimelineMessages(messages)
        }
    }

    private fun replaceOptimisticMessages(sessionId: String, messages: List<TimelineMessage>) {
        synchronized(optimisticLock) {
            if (messages.isEmpty()) {
                optimisticMessagesBySession.remove(sessionId)
            } else {
                optimisticMessagesBySession[sessionId] = sortTimelineMessages(messages.filter { it.optimistic })
            }
        }
    }

    private fun TimelineMessage.matchesClientMessage(clientMessageId: String): Boolean {
        return author == MessageAuthor.User && this.clientMessageId == clientMessageId
    }

    private fun List<TimelineMessage>.hasPendingOptimisticSend(): Boolean {
        return any { it.optimistic && it.status == "pending" }
    }

    private fun RemoteUploadedAttachment.toTimelineAttachment(): TimelineAttachment {
        return TimelineAttachment(
            fileId = fileId,
            name = name,
            mediaType = mediaType,
            size = size,
            sha256 = sha256,
        )
    }

    private fun TimelineAttachment.toRemoteAttachmentRef(): RemoteAttachmentRef {
        return RemoteAttachmentRef(
            fileId = fileId,
        )
    }

    private fun JSONObject.toTimelineAttachmentOrNull(): TimelineAttachment? {
        val fileId = text("fileId")?.takeIf { it.isNotBlank() } ?: return null
        return TimelineAttachment(
            fileId = fileId,
            name = text("name") ?: fileId,
            mediaType = text("mediaType").orEmpty(),
            size = optLong("size", 0L),
            sha256 = text("sha256"),
        )
    }

    private fun RemoteTimelineItem.toTimelineMessages(): List<TimelineMessage> {
        return when (type) {
            "message" -> listOf(toMessage())
            "tool" -> toToolMessages()
            "artifact" -> toArtifactMessages()
            "marker" -> listOf(toMarkerMessage())
            "system" -> listOf(toSystemMessage())
            "turn.start", "turn.end" -> null
            else -> listOf(toDiagnosticMessage())
        } ?: emptyList()
    }

    private fun mergeRemoteTimelineItems(
        currentOrdering: List<TimelineOrderingItem>,
        currentMessages: List<TimelineMessage>,
        incoming: List<RemoteTimelineItem>,
        replace: Boolean,
    ): TimelineProjection {
        val latestIncoming = latestTimelineItemsById(incoming)
        val normalizedIncoming = normalizeTimelineOrderingItems(currentOrdering, latestIncoming)
        val orderingItems = if (replace) {
            normalizedIncoming
        } else {
            mergeTimelineOrderingItems(currentOrdering, normalizedIncoming)
        }
        val normalizedOrderById = orderingItems.associateBy { it.id }
        val incomingMessages = latestIncoming.flatMap { item ->
            val orderSeq = normalizedOrderById[item.id]?.orderSeq ?: item.orderSeq
            item.toTimelineMessages().map { it.copy(orderSeq = orderSeq) }
        }
        val messages = if (replace) {
            sortTimelineMessages(incomingMessages, orderingItems)
        } else {
            mergeTimelineMessages(currentMessages, incomingMessages, orderingItems)
        }
        return TimelineProjection(orderingItems, messages)
    }

    private fun latestTimelineItemsById(incoming: List<RemoteTimelineItem>): List<RemoteTimelineItem> {
        val byId = linkedMapOf<String, RemoteTimelineItem>()
        incoming.forEach { observed ->
            val existing = byId[observed.id]
            if (existing == null || observed.revision > existing.revision ||
                observed.updatedSeq >= existing.updatedSeq
            ) {
                byId[observed.id] = observed
            }
        }
        return byId.values.toList()
    }

    private fun RemoteTimelineItem.toToolMessages(): List<TimelineMessage> {
        return when (content.text("kind")) {
            "command" -> listOf(toCommandMessage())
            "file_change" -> toFileChangeMessages()
            "web_search" -> listOf(toToolCallMessage(title = "Searched web", subtitle = content.text("query").orEmpty()))
            "mcp" -> listOf(
                toToolCallMessage(
                    title = content.text("tool") ?: "tool",
                    subtitle = content.text("server") ?: "mcp",
                )
            )
            "tool_call", "tool_result", "permission", "input_request" -> listOf(
                toToolCallMessage(title = shortToolTitle(), subtitle = content.text("kind").orEmpty()),
            )
            else -> listOf(toDiagnosticMessage())
        }
    }

    private fun RemoteTimelineItem.toMessage(): TimelineMessage {
        val contentKind = content.text("kind")
        val nestedContent = content.optJSONObject("content")
        val attachments = (
            content.records("attachments") + nestedContent?.records("attachments").orEmpty()
        ).mapNotNull { it.toTimelineAttachmentOrNull() }
            .distinctBy { it.fileId }
        val messageText = text
            .ifBlank { content.platformMessageText().orEmpty() }
            .stripInjectedAttachmentMentions()
        if (contentKind !in setOf(null, "text", "markdown", "multimodal") ||
            (messageText.isBlank() && attachments.isEmpty())
        ) {
            return toDiagnosticMessage()
        }
        val author = when (role) {
            "user" -> MessageAuthor.User
            "assistant" -> MessageAuthor.Agent
            else -> MessageAuthor.Tool
        }
        return TimelineMessage(
            id = id,
            sourceItemId = id,
            author = author,
            text = messageText,
            attachments = attachments,
            status = status,
            type = type,
            badge = status.statusLabel(),
            orderSeq = orderSeq,
            revision = revision,
            updatedSeq = updatedSeq,
            clientMessageId = source.text("clientMessageId"),
            turnId = turnId,
        )
    }

    private fun JSONObject.platformMessageText(): String? {
        firstText("text", "message", "description", "rawText")?.let { return it }
        return when (val nested = opt("content")) {
            is String -> nested.takeIf(String::isNotBlank)
            is JSONObject -> nested.firstText("text", "message", "description", "rawText")
            is JSONArray -> buildList {
                repeat(nested.length()) { index ->
                    when (val part = nested.opt(index)) {
                        is String -> part.takeIf(String::isNotBlank)?.let(::add)
                        is JSONObject -> part.firstText("text", "message", "description", "rawText")?.let(::add)
                    }
                }
            }.takeIf(List<String>::isNotEmpty)?.joinToString("\n")
            else -> null
        }
    }

    private fun RemoteTimelineItem.toSystemMessage(): TimelineMessage {
        val kind = content.text("kind") ?: "system"
        if (kind == "reasoning") {
            val summaries = content.records("summaries").mapNotNull { it.text("text") }
            val rawText = content.text("rawText") ?: content.text("text")
            val body = (if (summaries.isNotEmpty()) summaries else listOfNotNull(rawText))
                .joinToString("\n\n")
            return TimelineMessage(
                id = id,
                sourceItemId = id,
                author = MessageAuthor.Agent,
                text = body,
                status = status,
                type = type,
                kind = TimelineMessageKind.Reasoning,
                title = "Reasoning",
                badge = status.statusLabel(),
                orderSeq = orderSeq,
                revision = revision,
                updatedSeq = updatedSeq,
                clientMessageId = source.text("clientMessageId"),
                turnId = turnId,
            )
        }
        if (kind == "compact") return toCompactMessage()
        if (kind !in setOf("runtime", "system", "turn_start", "turn_end", "error", "notice")) {
            return toDiagnosticMessage()
        }
        val message = content.text("message") ?: content.text("text") ?: kind
        return TimelineMessage(
            id = id,
            sourceItemId = id,
            author = MessageAuthor.Tool,
            text = message,
            status = status,
            type = type,
            kind = if (kind == "error" || status == "failed") TimelineMessageKind.Error else TimelineMessageKind.System,
            title = kind,
            badge = status.statusLabel(),
            orderSeq = orderSeq,
            revision = revision,
            updatedSeq = updatedSeq,
            clientMessageId = source.text("clientMessageId"),
            turnId = turnId,
        )
    }

    private fun RemoteTimelineItem.toArtifactMessages(): List<TimelineMessage> {
        val kind = content.text("kind") ?: return listOf(toDiagnosticMessage())
        if (kind == "file_change") return toFileChangeMessages()
        if (kind !in setOf("file", "diff", "image", "document", "code")) {
            return listOf(toDiagnosticMessage())
        }
        val path = content.firstText("path", "filePath", "file", "uri")
        val title = path?.substringAfterLast('/')?.ifBlank { null } ?: kind
        return listOf(
            TimelineMessage(
                id = id,
                sourceItemId = id,
                author = MessageAuthor.Tool,
                text = title,
                status = status,
                type = type,
                kind = TimelineMessageKind.Artifact,
                title = kind.replaceFirstChar { it.uppercase() },
                subtitle = title,
                badge = status.statusLabel(),
                detail = path.orEmpty(),
                body = content.text("description") ?: content.text("text").orEmpty(),
                orderSeq = orderSeq,
                revision = revision,
                updatedSeq = updatedSeq,
                clientMessageId = source.text("clientMessageId"),
                turnId = turnId,
            ),
        )
    }

    private fun RemoteTimelineItem.toMarkerMessage(): TimelineMessage {
        val kind = content.text("kind") ?: return toDiagnosticMessage()
        if (kind == "compact") return toCompactMessage()
        if (kind !in setOf("system", "runtime", "notice", "error")) return toDiagnosticMessage()
        val label = content.firstText("label", "title", "text", "message") ?: kind
        return baseInformationalMessage(
            kind = if (kind == "error" || status == "failed") TimelineMessageKind.Error else TimelineMessageKind.Marker,
            title = kind,
            text = label,
        )
    }

    private fun RemoteTimelineItem.toCompactMessage(): TimelineMessage {
        val compactState = content.text("state")
        val active = compactState in setOf("started", "running", "inProgress") || status in setOf("pending", "running")
        val failed = compactState == "failed" || status == "failed"
        return baseInformationalMessage(
            kind = if (failed) TimelineMessageKind.Error else TimelineMessageKind.Marker,
            title = "compact",
            text = when {
                failed -> "Conversation compaction failed"
                active -> "Compacting conversation"
                else -> "Conversation compacted"
            },
        )
    }

    private fun RemoteTimelineItem.toDiagnosticMessage(): TimelineMessage {
        val contentKind = content.text("kind") ?: "unknown"
        return baseInformationalMessage(
            kind = TimelineMessageKind.Diagnostic,
            title = "Unknown timeline item",
            text = "${type.ifBlank { "unknown" }} / $contentKind · ${id.take(48)} · ${status.ifBlank { "unknown" }}",
        )
    }

    private fun RemoteTimelineItem.baseInformationalMessage(
        kind: TimelineMessageKind,
        title: String,
        text: String,
    ): TimelineMessage {
        return TimelineMessage(
            id = id,
            sourceItemId = id,
            author = MessageAuthor.Tool,
            text = text,
            status = status,
            type = type,
            kind = kind,
            title = title,
            badge = status.statusLabel(),
            orderSeq = orderSeq,
            revision = revision,
            updatedSeq = updatedSeq,
            clientMessageId = source.text("clientMessageId"),
            turnId = turnId,
        )
    }

    private fun RemoteTimelineItem.toCommandMessage(): TimelineMessage {
        val command = content.opt("command").commandText()
        val description = content.text("description") ?: command
        val output = content.firstText("output", "outputPreview", "outputText", "error").orEmpty()
        val exit = content.text("exitCode")?.let { "exit code $it" }.orEmpty()
        return TimelineMessage(
            id = id,
            sourceItemId = id,
            author = MessageAuthor.Tool,
            text = description.ifBlank { "command" },
            status = status,
            type = type,
            kind = TimelineMessageKind.Command,
            title = "Ran",
            subtitle = description.ifBlank { command.ifBlank { "command" } },
            badge = status.statusLabel(),
            detail = command,
            body = listOf(output, exit).filter { it.isNotBlank() }.joinToString("\n"),
            orderSeq = orderSeq,
            revision = revision,
            updatedSeq = updatedSeq,
            clientMessageId = source.text("clientMessageId"),
            turnId = turnId,
        )
    }

    private fun RemoteTimelineItem.toFileChangeMessages(): List<TimelineMessage> {
        val changes = content.records("changes")
        if (changes.isEmpty()) return listOf(toFileChangeMessage(JSONObject(), 0))
        return changes.mapIndexed { index, change -> toFileChangeMessage(change, index) }
    }

    private fun RemoteTimelineItem.toFileChangeMessage(change: JSONObject, index: Int): TimelineMessage {
        val targetPath = change.firstText("path", "filePath", "file", "uri").orEmpty()
        val filename = targetPath.substringAfterLast('/').ifBlank { targetPath.ifBlank { "files" } }
        val verb = change.fileChangeVerb()
        return TimelineMessage(
            id = if (index == 0) id else "$id:$index",
            sourceItemId = id,
            author = MessageAuthor.Tool,
            text = "$verb $filename",
            status = status,
            type = type,
            kind = TimelineMessageKind.FileChange,
            title = verb,
            subtitle = filename,
            badge = status.statusLabel(),
            detail = targetPath,
            body = change.text("diff").orEmpty(),
            orderSeq = orderSeq,
            revision = revision,
            updatedSeq = updatedSeq,
            clientMessageId = source.text("clientMessageId"),
            turnId = turnId,
        )
    }

    private fun RemoteTimelineItem.toToolCallMessage(title: String, subtitle: String): TimelineMessage {
        val name = title.ifBlank { "tool" }
        val inputSummary = content.opt("input").diagnosticSummary()
        val outputSummary = content.opt("output").diagnosticSummary()
        val errorSummary = content.opt("error").diagnosticSummary()
        return TimelineMessage(
            id = id,
            sourceItemId = id,
            author = MessageAuthor.Tool,
            text = name,
            status = status,
            type = type,
            kind = TimelineMessageKind.ToolCall,
            title = name,
            subtitle = subtitle,
            badge = status.statusLabel(),
            detail = inputSummary,
            body = listOf(outputSummary, errorSummary).filter(String::isNotBlank).joinToString("\n"),
            orderSeq = orderSeq,
            revision = revision,
            updatedSeq = updatedSeq,
            clientMessageId = source.text("clientMessageId"),
            turnId = turnId,
        )
    }

    private fun RemoteTimelineItem.shortToolTitle(): String {
        return content.text("function")
            ?: content.text("name")
            ?: content.text("tool")
            ?: content.text("kind")
            ?: "tool"
    }

    private fun RemoteSession.toAgentSession(devicesById: Map<String, AgentDevice>): AgentSession {
        val statusValue = status.toSessionStatus()
        val runtimeText = runtime.runtimeLabel()
        val deviceName = devicesById[connectorId]?.name ?: connectorId.take(8).ifBlank { "Device" }
        val workspace = cwd?.trim()?.trimEnd('/')?.substringAfterLast('/').orEmpty()
        return AgentSession(
            id = id,
            connectorId = connectorId,
            deviceName = deviceName,
            title = title?.takeIf { it.isNotBlank() }
                ?: externalSessionId?.takeIf { it.isNotBlank() }
                ?: "Untitled session",
            summary = cwd.orEmpty(),
            cwd = cwd,
            workspaceLabel = workspace,
            runtime = runtime,
            runtimeLabel = runtimeText,
            status = statusValue,
            statusLabel = statusValue.statusLabel(),
            updatedAtLabel = "",
            metaLabel = listOf(runtimeText, deviceName, workspace)
                .filter { it.isNotBlank() }
                .joinToString("  ·  "),
            pinned = pinned,
            archived = archived,
            unread = unread,
            lastReadSeq = lastReadSeq,
            takeover = takeover,
            connectorOnline = connectorStatus == "online",
            live = statusValue == SessionStatus.Running || statusValue == SessionStatus.WaitingApproval,
            sortKey = sortAt ?: lastActivityAt ?: lastItemAt ?: "",
            updatedSeq = updatedSeq,
        )
    }

    private fun String.toSessionStatus(): SessionStatus {
        return when (this) {
            "running" -> SessionStatus.Running
            "waiting_approval" -> SessionStatus.WaitingApproval
            "error" -> SessionStatus.Error
            else -> SessionStatus.Idle
        }
    }

    private fun SessionStatus.statusLabel(): String {
        return when (this) {
            SessionStatus.Idle -> "Idle"
            SessionStatus.Running -> "Running"
            SessionStatus.WaitingApproval -> "Approval"
            SessionStatus.Error -> "Error"
        }
    }

    private fun String.statusLabel(): String {
        return when (this) {
            "pending" -> "Pending"
            "running" -> "Running"
            "waiting_approval" -> "Approval"
            "done" -> "Done"
            "failed" -> "Failed"
            "cancelled" -> "Cancelled"
            "interrupted" -> "Stopped"
            else -> replace('_', ' ').replaceFirstChar { it.uppercase() }
        }
    }

    private fun JSONObject.text(name: String): String? {
        if (!has(name) || isNull(name)) return null
        return when (val value = opt(name)) {
            is String -> value.takeIf { it.isNotBlank() }
            is Number, is Boolean -> value.toString()
            else -> null
        }
    }

    private fun JSONObject.records(name: String): List<JSONObject> {
        val array = optJSONArray(name) ?: return emptyList()
        return List(array.length()) { index -> array.optJSONObject(index) }.filterNotNull()
    }

    private fun JSONObject.firstText(vararg names: String): String? {
        return names.firstNotNullOfOrNull { name -> text(name) }
    }

    private fun JSONObject.fileChangeVerb(): String {
        val kind = optJSONObject("kind")
        val type = kind?.text("type") ?: text("action")
        return when (type) {
            "add" -> "Added"
            "delete" -> "Deleted"
            "update" -> if (kind?.text("move_path") != null) "Renamed" else "Edited"
            else -> "Changed"
        }
    }

    private fun Any?.commandText(): String {
        return when (this) {
            is String -> this
            is JSONArray -> List(length()) { index -> opt(index).toString() }.joinToString(" ")
            else -> ""
        }
    }

    private fun Any?.diagnosticSummary(maxChars: Int = 512): String {
        val raw = when (this) {
            null, JSONObject.NULL -> ""
            is String -> this
            is Number, is Boolean -> toString()
            is JSONObject -> keys().asSequence().toList().sorted().joinToString(", ") { key ->
                val value = opt(key)
                "$key=${when (value) {
                    is String -> value
                    is Number, is Boolean -> value.toString()
                    is JSONArray -> "[${value.length()} items]"
                    is JSONObject -> "{${value.length()} fields}"
                    else -> "null"
                }}"
            }
            is JSONArray -> "[${length()} items]"
            else -> toString()
        }
        return raw.replace(Regex("(?i)(token|secret|password|authorization)=([^,\\s]+)"), "$1=[redacted]")
            .take(maxChars)
    }

    private fun String.stripInjectedAttachmentMentions(): String {
        val markers = listOf(
            "\n\n[Attached file: ",
            "\n\n[Failed to load attachment ",
            "\n\n[Attachments dropped ",
        )
        val cut = markers
            .map { marker -> indexOf(marker) }
            .filter { it >= 0 }
            .minOrNull() ?: length
        return take(cut).trimEnd()
    }

    private data class ApiAuth(
        val serverUrl: String,
        val accessToken: String,
    )

}

private data class TimelineProjection(
    val orderingItems: List<TimelineOrderingItem>,
    val messages: List<TimelineMessage>,
)

private fun normalizeTimelineOrderingItems(
    current: List<TimelineOrderingItem>,
    incoming: List<RemoteTimelineItem>,
): List<TimelineOrderingItem> {
    val currentById = current.associateBy { it.id }
    var maxOrderSeq = maxOf(
        current.maxOfOrNull { it.orderSeq.takeIf { value -> value > 0 } ?: 0 } ?: 0,
        incoming.maxOfOrNull { it.orderSeq.takeIf { value -> value > 0 } ?: 0 } ?: 0,
    )
    return incoming.map { item ->
        val existingOrder = currentById[item.id]?.orderSeq?.takeIf { it > 0 }
        val normalizedOrder = item.orderSeq.takeIf { it > 0 }
            ?: existingOrder
            ?: (++maxOrderSeq)
        TimelineOrderingItem(
            id = item.id,
            type = item.type,
            turnId = item.turnId,
            orderSeq = normalizedOrder,
            revision = item.revision,
            updatedSeq = item.updatedSeq,
        )
    }
}

internal fun mergeTimelineOrderingItems(
    current: List<TimelineOrderingItem>,
    incoming: List<TimelineOrderingItem>,
): List<TimelineOrderingItem> {
    val byId = current.associateByTo(linkedMapOf()) { it.id }
    incoming.forEach { observed ->
        val existing = byId[observed.id]
        if (existing == null || observed.revision > existing.revision || observed.updatedSeq >= existing.updatedSeq) {
            byId[observed.id] = observed.copy(
                orderSeq = observed.orderSeq.takeIf { it > 0 }
                    ?: existing?.orderSeq?.takeIf { it > 0 }
                    ?: ((byId.values.maxOfOrNull { it.orderSeq } ?: 0) + 1),
            )
        }
    }
    return byId.values.toList()
}

internal fun sortTimelineMessages(
    messages: List<TimelineMessage>,
    orderingItems: List<TimelineOrderingItem> = emptyList(),
): List<TimelineMessage> {
    val orderingById = orderingItems.associateBy { it.id }
    val turnAnchors = mutableMapOf<String, Int>()
    orderingItems.forEach { item ->
        val turnId = item.turnId ?: return@forEach
        turnAnchors[turnId] = minOf(turnAnchors[turnId] ?: item.orderSeq, item.orderSeq)
    }
    messages.forEach { message ->
        val turnId = message.turnId ?: return@forEach
        val itemOrder = orderingById[message.sourceItemId]?.orderSeq ?: message.orderSeq
        turnAnchors[turnId] = minOf(turnAnchors[turnId] ?: itemOrder, itemOrder)
    }
    return messages.sortedWith { left, right ->
        val leftOrder = orderingById[left.sourceItemId]?.orderSeq ?: left.orderSeq
        val rightOrder = orderingById[right.sourceItemId]?.orderSeq ?: right.orderSeq
        val leftBlock = left.turnId?.let(turnAnchors::get) ?: leftOrder
        val rightBlock = right.turnId?.let(turnAnchors::get) ?: rightOrder
        compareValues(leftBlock, rightBlock)
            .takeIf { it != 0 }
            ?: compareValues(leftOrder, rightOrder).takeIf { it != 0 }
            ?: compareValues(left.updatedSeq, right.updatedSeq).takeIf { it != 0 }
            ?: left.id.compareTo(right.id)
    }
}

internal fun mergeTimelineMessages(
    current: List<TimelineMessage>,
    incoming: List<TimelineMessage>,
    orderingItems: List<TimelineOrderingItem> = emptyList(),
): List<TimelineMessage> {
    val currentBySource = current.filterNot { it.optimistic }.groupBy { it.sourceItemId }
    val incomingBySource = incoming.filterNot { it.optimistic }.groupBy { it.sourceItemId }
    val sourceIds = currentBySource.keys + incomingBySource.keys
    return sourceIds.flatMap { sourceId ->
        val currentGroup = currentBySource[sourceId].orEmpty()
        val incomingGroup = incomingBySource[sourceId].orEmpty()
        if (incomingGroup.isEmpty()) return@flatMap currentGroup
        if (currentGroup.isEmpty()) return@flatMap incomingGroup
        val currentRevision = currentGroup.maxOf { it.revision }
        val incomingRevision = incomingGroup.maxOf { it.revision }
        val currentUpdatedSeq = currentGroup.maxOf { it.updatedSeq }
        val incomingUpdatedSeq = incomingGroup.maxOf { it.updatedSeq }
        if (incomingRevision > currentRevision || incomingUpdatedSeq >= currentUpdatedSeq) {
            incomingGroup
        } else {
            currentGroup
        }
    }.let { sortTimelineMessages(it, orderingItems) }
}

internal fun mergeRuntimeNotices(
    current: List<RuntimeNotice>,
    incoming: List<RemoteRuntimeNotice>,
    replace: Boolean,
): List<RuntimeNotice> {
    val currentById = current.associateBy { it.noticeId }
    val incomingById = incoming.map { it.toRuntimeNotice() }.associateBy { it.noticeId }
    val noticeIds = if (replace) incomingById.keys else currentById.keys + incomingById.keys
    return noticeIds.mapNotNull { noticeId ->
        val existing = currentById[noticeId]
        val observed = incomingById[noticeId]
        when {
            observed == null -> existing
            existing == null -> observed
            observed.revision > existing.revision -> observed
            observed.updatedSeq >= existing.updatedSeq -> observed
            else -> existing
        }
    }.sortedWith(compareBy<RuntimeNotice> { it.updatedSeq }.thenBy { it.noticeId })
}

private fun RemoteRuntimeNotice.toRuntimeNotice(): RuntimeNotice {
    return RuntimeNotice(
        noticeId = noticeId,
        type = type,
        sessionId = sessionId,
        title = title,
        message = message,
        severity = severity,
        status = status,
        interactionType = interactionType,
        blocking = blocking?.let { RuntimeNoticeBlocking(scope = it.scope, targetId = it.targetId) },
        responseRequired = responseRequired,
        revision = revision,
        updatedSeq = updatedSeq,
        source = source,
        actions = actions.map { it.toRuntimeNoticeAction() },
        context = context,
        metadata = metadata,
        expiresAt = expiresAt,
        createdAt = createdAt,
        updatedAt = updatedAt,
        resolvedAt = resolvedAt,
    )
}

internal fun RemoteSessionRuntimeState?.toSessionRuntimeState(serverTime: String?): SessionRuntimeState {
    if (this == null) {
        return SessionRuntimeState(
            serverTime = serverTime,
            isLoaded = true,
        )
    }
    return SessionRuntimeState(
        sessionId = sessionId,
        runtime = runtime,
        externalSessionId = externalSessionId,
        status = when (status) {
            "idle" -> SessionRuntimeStatus.Idle
            "running" -> SessionRuntimeStatus.Running
            "waiting_approval" -> SessionRuntimeStatus.WaitingApproval
            "error" -> SessionRuntimeStatus.Error
            else -> SessionRuntimeStatus.Unknown
        },
        selections = selections,
        statusReason = statusReason,
        error = error,
        metadata = metadata,
        updatedSeq = updatedSeq,
        createdAt = createdAt,
        updatedAt = updatedAt,
        serverTime = serverTime,
        isLoaded = true,
    )
}

internal fun RemoteRuntimeCapabilitySet.toEffectiveCapabilities(
    connectorId: String?,
    serverTime: String?,
): EffectiveCapabilities {
    return EffectiveCapabilities(
        revision = revision,
        capabilities = capabilities.map { it.toEffectiveCapability() },
        connectorId = connectorId,
        serverTime = serverTime,
        isLoaded = true,
    )
}

internal fun RemoteRuntimeCapabilitySet.toRuntimeCapabilities(): RuntimeCapabilities {
    return RuntimeCapabilities(
        revision = revision,
        capabilities = capabilities.map { it.toEffectiveCapability() },
        isLoaded = true,
    )
}

private fun RemoteRuntimeCapability.toEffectiveCapability(): EffectiveCapability {
    return EffectiveCapability(
        capabilityId = capabilityId,
        version = version,
        scope = scope,
        runtime = runtime,
        sessionId = sessionId,
        supported = supported,
        available = available,
        allowed = allowed,
        unavailableReason = unavailableReason,
        parameters = parameters,
    )
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

data class SendMessageResult(
    val turnId: String?,
    val attachments: List<TimelineAttachment>,
)

data class CommandExecutionResult(
    val command: String,
    val code: String?,
    val message: String?,
    val result: Any?,
)
