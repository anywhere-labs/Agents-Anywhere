package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RemoteRuntimeCapability
import com.agentsanywhere.app.api.RemoteRuntimeCapabilitySet
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
                val realMessages = snapshot.timeline.items.flatMap { it.toTimelineMessages() }
                val messages = mergeOptimistic(
                    sessionId = sessionId,
                    realMessages = realMessages,
                    currentMessages = currentState?.messages.orEmpty(),
                )
                SessionDetailState(
                    meta = SessionMeta(
                        session = snapshot.session.toAgentSession(devices.associateBy { it.id }),
                        serverTime = snapshot.serverTime,
                    ),
                    timeline = SessionTimelineState(
                        messages = messages,
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
                    ),
                    // Snapshot catalogs are compatibility data. Existing-session selectors
                    // always use the live session-scoped catalog endpoints.
                    catalogs = currentState?.catalogs ?: RuntimeCatalogs(),
                    commands = currentState?.commands ?: RuntimeCommands(),
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
                    val incoming = page.items.flatMap { it.toTimelineMessages() }
                    val realMessages = mergeTimelineMessages(
                        current = next.messages.filterNot { it.optimistic },
                        incoming = incoming,
                    )
                    next = next.copy(
                        timeline = next.timeline.copy(
                            messages = mergeOptimistic(sessionId, realMessages, next.messages),
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
                SessionTimelineState(
                    messages = page.items.flatMap { it.toTimelineMessages() },
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
                    sessionsApi.uploadSessionAttachments(
                        serverUrl = auth.serverUrl,
                        authorizationToken = auth.accessToken,
                        sessionId = sessionId,
                        files = attachments,
                    ).map { it.toTimelineAttachment() }
                }
                val response = if (steer) {
                    sessionsApi.steerSession(
                        serverUrl = auth.serverUrl,
                        authorizationToken = auth.accessToken,
                        sessionId = sessionId,
                        content = content.ifBlank { ATTACHMENT_ONLY_PROMPT },
                        clientMessageId = clientMessageId,
                        attachments = uploaded.map { it.toRemoteUploadedAttachment() },
                    )
                } else {
                    sessionsApi.sendSessionMessage(
                        serverUrl = auth.serverUrl,
                        authorizationToken = auth.accessToken,
                        sessionId = sessionId,
                        content = content.ifBlank { ATTACHMENT_ONLY_PROMPT },
                        clientMessageId = clientMessageId,
                        attachments = uploaded.map { it.toRemoteUploadedAttachment() },
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
                sessionsApi.uploadSessionAttachments(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    sessionId = sessionId,
                    files = attachments,
                ).map { it.toTimelineAttachment() }
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
        val realMessages = mergeTimelineMessages(
            current = current.messages.filterNot { it.optimistic },
            incoming = older.messages,
        )
        val messages = mergeOptimistic(
            sessionId = sessionId,
            realMessages = realMessages,
            currentMessages = current.messages,
        )
        return current.copy(
            timeline = current.timeline.copy(
                messages = messages,
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
    ): SessionDetailState {
        val message = TimelineMessage(
            id = clientMessageId,
            sourceItemId = clientMessageId,
            author = MessageAuthor.User,
            text = text,
            attachments = attachments,
            status = "pending",
            badge = "Sending",
            orderSeq = Int.MAX_VALUE,
            updatedSeq = 0,
            clientMessageId = clientMessageId,
            turnId = null,
            optimistic = true,
        )
        upsertOptimisticMessage(sessionId, message)
        return state.copy(
            timeline = state.timeline.copy(
                messages = mergeOptimistic(
                    sessionId = sessionId,
                    realMessages = state.messages,
                    currentMessages = state.messages + message,
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
    ): SessionDetailState {
        val updatedMessages = state.messages.map { message ->
            if (message.id == clientMessageId && message.optimistic) {
                message.copy(
                    status = status,
                    badge = status.statusLabel(),
                    turnId = turnId ?: message.turnId,
                    attachments = attachments.ifEmpty { message.attachments },
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
                ),
            ),
            sending = false,
            actionError = if (status == "failed") state.actionError else null,
        )
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
    ): List<TimelineMessage> {
        val real = realMessages.filterNot { it.optimistic }
        val optimistic = (currentMessages.filter { it.optimistic } + optimisticMessages(sessionId))
            .distinctBy { it.id }
        val pending = optimistic.filter { optimisticMessage ->
            optimisticMessage.status == "failed" ||
                real.none { realMessage -> realMessage.matchesClientMessage(optimisticMessage.id) }
        }
        replaceOptimisticMessages(sessionId, pending)
        return sortMessages(real + pending)
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
            optimisticMessagesBySession[sessionId] = sortMessages(messages)
        }
    }

    private fun replaceOptimisticMessages(sessionId: String, messages: List<TimelineMessage>) {
        synchronized(optimisticLock) {
            if (messages.isEmpty()) {
                optimisticMessagesBySession.remove(sessionId)
            } else {
                optimisticMessagesBySession[sessionId] = sortMessages(messages.filter { it.optimistic })
            }
        }
    }

    private fun sortMessages(messages: List<TimelineMessage>): List<TimelineMessage> {
        return messages.sortedWith(
            compareBy<TimelineMessage> { it.orderSeq }
                .thenBy { it.updatedSeq }
                .thenBy { it.id },
        )
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
        )
    }

    private fun TimelineAttachment.toRemoteUploadedAttachment(): RemoteUploadedAttachment {
        return RemoteUploadedAttachment(
            fileId = fileId,
            name = name,
            mediaType = mediaType,
            size = size,
        )
    }

    private fun JSONObject.toTimelineAttachmentOrNull(): TimelineAttachment? {
        val fileId = text("fileId")?.takeIf { it.isNotBlank() } ?: return null
        return TimelineAttachment(
            fileId = fileId,
            name = text("name") ?: fileId,
            mediaType = text("mediaType").orEmpty(),
            size = optLong("size", 0L),
        )
    }

    private fun RemoteTimelineItem.toTimelineMessages(): List<TimelineMessage> {
        return when (type) {
            "message" -> listOf(toTextMessage())
            "tool" -> toToolMessages()
            "system" -> listOfNotNull(toSystemMessage())
            "artifact" -> if (content.text("kind") == "diff") emptyList() else listOfNotNull(toSystemMessage())
            "turn.start", "turn.end" -> null
            else -> listOfNotNull(toSystemMessage())
        } ?: emptyList()
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
            else -> listOf(toToolCallMessage(title = shortToolTitle(), subtitle = content.text("kind").orEmpty()))
        }
    }

    private fun RemoteTimelineItem.toTextMessage(): TimelineMessage {
        val author = when (role) {
            "user" -> MessageAuthor.User
            "assistant" -> MessageAuthor.Agent
            else -> MessageAuthor.Tool
        }
        return TimelineMessage(
            id = id,
            sourceItemId = id,
            author = author,
            text = (text.ifBlank { content.text("text").orEmpty() }).stripInjectedAttachmentMentions(),
            attachments = content.records("attachments").mapNotNull { it.toTimelineAttachmentOrNull() },
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

    private fun RemoteTimelineItem.toSystemMessage(): TimelineMessage? {
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
        val message = content.text("message") ?: content.text("text") ?: kind
        if (message.isBlank()) return null
        return TimelineMessage(
            id = id,
            sourceItemId = id,
            author = MessageAuthor.Tool,
            text = message,
            status = status,
            type = type,
            kind = TimelineMessageKind.System,
            title = kind,
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
        val output = content.text("outputPreview") ?: content.text("outputText").orEmpty()
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
        val targetPath = change.text("path").orEmpty()
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

    private companion object {
        const val ATTACHMENT_ONLY_PROMPT = "(No text content.)"
    }
}

internal fun mergeTimelineMessages(
    current: List<TimelineMessage>,
    incoming: List<TimelineMessage>,
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
    }.sortedWith(
        compareBy<TimelineMessage> { it.orderSeq }
            .thenBy { it.updatedSeq }
            .thenBy { it.id },
    )
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
