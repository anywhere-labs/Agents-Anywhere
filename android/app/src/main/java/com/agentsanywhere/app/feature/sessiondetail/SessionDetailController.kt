package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RemoteRpcResponse
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.RemoteRuntimeModelCatalog
import com.agentsanywhere.app.api.RemoteRuntimePermissionCatalog
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.UploadFilePart
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.sessions.toAgentSession
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlin.math.max

private const val INITIAL_TIMELINE_LIMIT = 100
private const val TIMELINE_PAGE_LIMIT = 100

class SessionDetailController(
    private val sessionsApi: SessionsApi,
    private val sessionStore: AuthSessionReader,
) {
    private val optimisticStore = SessionOptimisticMessageStore()
    private val attachmentTransfer = SessionAttachmentTransfer(sessionsApi)

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
                    catalogs = RuntimeCatalogs(
                        model = snapshot.catalogs.model,
                        permission = snapshot.catalogs.permission,
                    ),
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
        val next = reduceRealtimeEvent(current, event, devices)
        current.session?.id?.let { sessionId ->
            optimisticStore.replace(sessionId, next.messages.filter { it.optimistic })
        }
        return next
    }

    fun applyRealtimeEvents(
        current: SessionDetailState,
        events: List<RemoteSessionEventEnvelope>,
        devices: List<AgentDevice>,
    ): SessionDetailState {
        val next = reduceRealtimeEvents(current, events, devices)
        current.session?.id?.let { sessionId ->
            optimisticStore.replace(sessionId, next.messages.filter { it.optimistic })
        }
        return next
    }

    fun mergeRuntimeLiveState(
        current: SessionDetailState,
        requestState: SessionDetailState,
        refreshed: SessionDetailState,
    ): SessionDetailState = reduceRuntimeLiveState(current, requestState, refreshed)

    fun mergeSnapshotWithLiveState(
        sessionId: String,
        snapshot: SessionDetailState,
        live: SessionDetailState,
    ): SessionDetailState {
        val next = reduceSnapshotWithLiveState(snapshot, live)
        optimisticStore.replace(sessionId, next.messages.filter { it.optimistic })
        return next
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
                    attachmentTransfer.upload(auth.serverUrl, auth.accessToken, sessionId, attachments)
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
                if (!response.ok) {
                    throw IllegalStateException(response.failureMessage("Runtime rejected the message."))
                }
                SendMessageResult(attachments = uploaded)
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
                attachmentTransfer.upload(auth.serverUrl, auth.accessToken, sessionId, attachments)
            }
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
            attachmentTransfer.imageRequest(auth.serverUrl, auth.accessToken, sessionId, attachment)
        }
    }

    suspend fun downloadAttachment(
        sessionId: String,
        attachment: TimelineAttachment,
    ): Result<DownloadedAttachment> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                attachmentTransfer.download(auth.serverUrl, auth.accessToken, sessionId, attachment)
            }
        }
    }

    suspend fun interrupt(sessionId: String): Result<Unit> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val response = sessionsApi.interruptSession(auth.serverUrl, auth.accessToken, sessionId)
                if (!response.ok) {
                    throw IllegalStateException(response.failureMessage("Runtime rejected the interrupt."))
                }
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
                val response = sessionsApi.respondRuntimeNotice(
                    auth.serverUrl,
                    auth.accessToken,
                    sessionId,
                    noticeId,
                    actionId,
                    input,
                )
                if (!response.ok) {
                    throw RuntimeNoticeResponseException(
                        code = response.errorCode,
                        message = response.failureMessage("Runtime rejected the response."),
                    )
                }
                Unit
            }
        }
    }

    private fun RemoteRpcResponse.failureMessage(fallback: String): String {
        return errorMessage?.takeIf(String::isNotBlank)
            ?: errorCode?.takeIf(String::isNotBlank)
            ?: fallback
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
            optimistic = true,
            retryAction = retryAction,
        )
        optimisticStore.upsert(sessionId, message)
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
        attachments: List<TimelineAttachment> = emptyList(),
        errorMessage: String? = null,
    ): SessionDetailState {
        val updatedMessages = state.messages.map { message ->
            if (message.id == clientMessageId && message.optimistic) {
                message.copy(
                    status = status,
                    badge = status.statusLabel(),
                    attachments = attachments.ifEmpty { message.attachments },
                    errorMessage = errorMessage,
                )
            } else {
                message
            }
        }
        optimisticStore.replace(
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
        val merged = mergeOptimisticTimelineMessages(
            realMessages = realMessages,
            currentMessages = currentMessages,
            storedMessages = optimisticStore.read(sessionId),
            orderingItems = orderingItems,
        )
        optimisticStore.replace(sessionId, merged.pending)
        return merged.messages
    }

    private data class ApiAuth(
        val serverUrl: String,
        val accessToken: String,
    )

}

internal class RuntimeNoticeResponseException(
    val code: String?,
    message: String,
) : IllegalStateException(message)

data class SendMessageResult(
    val attachments: List<TimelineAttachment>,
)

data class CommandExecutionResult(
    val command: String,
    val code: String?,
    val message: String?,
    val result: Any?,
)
