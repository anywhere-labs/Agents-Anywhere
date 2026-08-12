package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.DevicesApi
import com.agentsanywhere.app.api.FilesApi
import com.agentsanywhere.app.api.RemoteInlineAttachmentRef
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.RemoteDevice
import com.agentsanywhere.app.api.RemoteSession
import com.agentsanywhere.app.api.RemoteSessionCreateAndStartRequest
import com.agentsanywhere.app.api.RemoteDashboardSnapshot
import com.agentsanywhere.app.api.RemoteSessionsMutationResponse
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.feature.devices.toAgentDevice
import com.agentsanywhere.app.feature.devices.toDeviceRuntimeList
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException
import java.io.IOException
import java.security.MessageDigest
import java.util.Base64

class SessionsController(
    private val sessionsApi: SessionsApi,
    private val devicesApi: DevicesApi,
    private val filesApi: FilesApi,
    private val sessionStore: AuthSessionStore,
) {
    fun dashboardSnapshotState(snapshot: RemoteDashboardSnapshot): SessionsState {
        return toState(snapshot.sessions, snapshot.devices)
    }
    suspend fun loadSessions(): Result<SessionsState> {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to load sessions."))
        }

        return withContext(Dispatchers.IO) {
            runCatching {
                val sessions = sessionsApi.listSessions(
                    serverUrl = serverUrl,
                    authorizationToken = accessToken,
                )
                val devices = devicesApi.listDevices(
                    serverUrl = serverUrl,
                    authorizationToken = accessToken,
                )
                toState(sessions, devices)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not load sessions.", error)
            }
        }
    }

    suspend fun renameSession(
        sessionId: String,
        title: String,
        devices: List<AgentDevice>,
    ): Result<AgentSession> {
        return patchSession(
            sessionId = sessionId,
            title = title,
            pinned = null,
            archived = null,
            devices = devices,
        )
    }

    suspend fun createAndStartSession(
        draft: NewSessionCreateDraft,
        devices: List<AgentDevice>,
    ): NewSessionCreateOutcome {
        validateNewSessionDraft(draft)?.let { error ->
            return NewSessionCreateOutcome.Failed(IllegalArgumentException(error))
        }
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) {
            return NewSessionCreateOutcome.Failed(IllegalStateException("Sign in again to create a session."))
        }

        return withContext(Dispatchers.IO) {
            try {
                val response = sessionsApi.createAndStartSession(
                    serverUrl = serverUrl,
                    authorizationToken = accessToken,
                    request = RemoteSessionCreateAndStartRequest(
                        connectorId = draft.connectorId,
                        runtime = draft.runtime,
                        title = draft.title?.trim()?.takeIf(String::isNotBlank),
                        cwd = draft.cwd?.trim()?.takeIf(String::isNotBlank),
                        content = draft.content.trim(),
                        selections = draft.selections.toMap(),
                        attachments = draft.attachments.map(NewSessionAttachmentPart::toInlineAttachmentRef),
                        clientMessageId = draft.clientMessageId,
                    ),
                )
                NewSessionCreateOutcome.Created(
                    session = response.session.toAgentSession(devices.associateBy { it.id }),
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (error.mayHaveUnknownCreateOutcome()) {
                    reconcileCreateAfterNetworkFailure(
                        draft = draft,
                        serverUrl = serverUrl,
                        accessToken = accessToken,
                        originalError = error,
                    )
                } else {
                    NewSessionCreateOutcome.Failed(error.asCreateFailure())
                }
            }
        }
    }

    private fun reconcileCreateAfterNetworkFailure(
        draft: NewSessionCreateDraft,
        serverUrl: String,
        accessToken: String,
        originalError: Throwable,
    ): NewSessionCreateOutcome {
        val refreshedState = runCatching {
            toState(
                remoteSessions = sessionsApi.listSessions(serverUrl, accessToken),
                remoteDevices = devicesApi.listDevices(serverUrl, accessToken),
            )
        }.getOrNull()
        val candidates = refreshedState?.newCreateCandidates(draft).orEmpty()
        return when {
            candidates.size == 1 -> NewSessionCreateOutcome.Created(
                session = candidates.single(),
                recoveredAfterNetworkFailure = true,
                refreshedState = refreshedState,
            )
            refreshedState != null && candidates.isEmpty() -> NewSessionCreateOutcome.Failed(
                error = originalError.asCreateFailure(),
                outcomeUnknown = false,
                refreshedState = refreshedState,
            )
            else -> NewSessionCreateOutcome.Failed(
                error = NewSessionCreateResultUnknownException(
                    "The create request ended before its result could be confirmed. Return to Sessions and refresh before trying again.",
                ),
                outcomeUnknown = true,
                refreshedState = refreshedState,
            )
        }
    }

    suspend fun listNewSessionDirectory(
        connectorId: String,
        root: String,
        path: String = ".",
    ): Result<NewSessionDirectory> {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to browse files."))
        }

        return withContext(Dispatchers.IO) {
            runCatching {
                val directory = filesApi.listFiles(
                    serverUrl = serverUrl,
                    authorizationToken = accessToken,
                    deviceId = connectorId,
                    root = root,
                    path = path,
                )
                NewSessionDirectory(
                    path = directory.path,
                    entries = directory.entries
                        .filter { it.type == "directory" }
                        .map {
                            NewSessionPathEntry(
                                name = it.name,
                                path = it.path,
                                isDirectory = true,
                                size = it.size,
                            )
                        }
                        .sortedBy { it.name.lowercase() },
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not load this directory.", error)
            }
        }
    }

    suspend fun listNewSessionRuntimes(
        connectorId: String,
    ): Result<DeviceRuntimeList> {
        val auth = newSessionAuth() ?: return Result.failure(
            IllegalStateException("Sign in again to load runtimes."),
        )
        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.listDeviceRuntimes(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                ).toDeviceRuntimeList()
            }.wrapNewSessionFailure("Could not load runtimes.")
        }
    }

    suspend fun loadNewSessionRuntimeCapabilities(
        connectorId: String,
        runtime: String,
    ): Result<NewSessionRuntimeCapabilities> {
        val auth = newSessionAuth() ?: return Result.failure(
            IllegalStateException("Sign in again to load runtime capabilities."),
        )
        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.getDeviceRuntimeCapabilities(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    runtime = runtime,
                ).toNewSessionRuntimeCapabilities()
            }.wrapNewSessionFailure("Could not load runtime capabilities.")
        }
    }

    suspend fun loadNewSessionModelCatalog(
        connectorId: String,
        runtime: String,
    ): Result<NewSessionModelCatalog> {
        val auth = newSessionAuth() ?: return Result.failure(
            IllegalStateException("Sign in again to load the model catalog."),
        )
        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.getDeviceRuntimeModelCatalog(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    runtime = runtime,
                ).toNewSessionModelCatalog()
            }.wrapNewSessionFailure("Could not load the model catalog.")
        }
    }

    suspend fun loadNewSessionPermissionCatalog(
        connectorId: String,
        runtime: String,
    ): Result<NewSessionPermissionCatalog> {
        val auth = newSessionAuth() ?: return Result.failure(
            IllegalStateException("Sign in again to load the permission catalog."),
        )
        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.getDeviceRuntimePermissionCatalog(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    runtime = runtime,
                ).toNewSessionPermissionCatalog()
            }.wrapNewSessionFailure("Could not load the permission catalog.")
        }
    }

    suspend fun setSessionPinned(
        sessionId: String,
        pinned: Boolean,
        devices: List<AgentDevice>,
    ): Result<AgentSession> {
        return patchSession(
            sessionId = sessionId,
            title = null,
            pinned = pinned,
            archived = null,
            devices = devices,
        )
    }

    suspend fun setSessionArchived(
        sessionId: String,
        archived: Boolean,
        devices: List<AgentDevice>,
    ): Result<AgentSession> {
        return patchSession(
            sessionId = sessionId,
            title = null,
            pinned = null,
            archived = archived,
            devices = devices,
        )
    }

    suspend fun loadSessionMeta(
        sessionId: String,
        devices: List<AgentDevice>,
    ): Result<AgentSession> {
        val auth = newSessionAuth()
            ?: return Result.failure(IllegalStateException("Sign in again to load this session."))
        return withContext(Dispatchers.IO) {
            runCatching {
                sessionsApi.getSessionMeta(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    sessionId = sessionId,
                ).session.toAgentSession(devices.associateBy { it.id })
            }.wrapNewSessionFailure("Could not load this session.")
        }
    }

    suspend fun markSessionRead(
        sessionId: String,
        devices: List<AgentDevice>,
    ): Result<AgentSession> {
        val auth = newSessionAuth()
            ?: return Result.failure(IllegalStateException("Sign in again to update this session."))
        return withContext(Dispatchers.IO) {
            runCatching {
                sessionsApi.markSessionRead(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    sessionId = sessionId,
                ).session.toAgentSession(devices.associateBy { it.id })
            }.wrapNewSessionFailure("Could not mark this session as read.")
        }
    }

    suspend fun markSessionsRead(
        ids: List<String>,
        devices: List<AgentDevice>,
    ): Result<SessionBatchUpdate> {
        return mutateSessions(ids, devices, "Could not mark sessions as read.") { serverUrl, accessToken, normalized ->
            sessionsApi.markSessionsRead(serverUrl, accessToken, normalized)
        }
    }

    suspend fun bulkSetSessionsArchived(
        ids: List<String>,
        archived: Boolean,
        devices: List<AgentDevice>,
    ): Result<SessionBatchUpdate> {
        return mutateSessions(ids, devices, "Could not update sessions.") { serverUrl, accessToken, normalized ->
            if (archived) {
                sessionsApi.archiveSessions(serverUrl, accessToken, normalized)
            } else {
                sessionsApi.unarchiveSessions(serverUrl, accessToken, normalized)
            }
        }
    }

    suspend fun archiveAllDeviceSessions(
        connectorId: String,
        archived: Boolean,
        scope: String,
        devices: List<AgentDevice>,
    ): Result<List<AgentSession>> {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to update sessions."))
        }

        return withContext(Dispatchers.IO) {
            runCatching {
                sessionsApi.archiveAllDeviceSessions(
                    serverUrl = serverUrl,
                    authorizationToken = accessToken,
                    deviceId = connectorId,
                    archived = archived,
                    scope = scope,
                ).map { it.toAgentSession(devices.associateBy { device -> device.id }) }
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not update sessions.", error)
            }
        }
    }

    private suspend fun patchSession(
        sessionId: String,
        title: String?,
        pinned: Boolean?,
        archived: Boolean?,
        devices: List<AgentDevice>,
    ): Result<AgentSession> {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to update this session."))
        }

        return withContext(Dispatchers.IO) {
            runCatching {
                sessionsApi.patchSession(
                    serverUrl = serverUrl,
                    authorizationToken = accessToken,
                    sessionId = sessionId,
                    title = title,
                    pinned = pinned,
                    archived = archived,
                ).session.toAgentSession(devices.associateBy { it.id })
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not update this session.", error)
            }
        }
    }

    private fun toState(
        remoteSessions: List<RemoteSession>,
        remoteDevices: List<RemoteDevice>,
    ): SessionsState {
        val devicesById = remoteDevices.associate { device ->
            device.id to device.toAgentDevice()
        }
        val allSessions = remoteSessions
            .sortedWith(sessionComparator())
            .map { session ->
                session.toAgentSession(devicesById)
            }
        val sessions = allSessions
            .filterNot { it.archived }
        val archivedSessions = allSessions.filter { it.archived }
        val devices = devicesById.values.sortedBy { it.name.lowercase() }

        return SessionsState(
            sessions = sessions,
            archivedSessions = archivedSessions,
            devices = devices,
            isLoading = false,
            errorMessage = null,
            hasLoaded = true,
        )
    }

    private fun RemoteSession.toAgentSession(devicesById: Map<String, AgentDevice>): AgentSession {
        val workspace = cwd.workspaceName()
        val statusValue = status.toSessionStatus()
        val displayTitle = title?.takeIf { it.isNotBlank() }
            ?: externalSessionId?.takeIf { it.isNotBlank() }
            ?: "Untitled session"
        val activityAt = lastActivityAt ?: lastItemAt ?: sortAt ?: sourceObservedAt ?: lastSyncedAt
        val runtimeText = runtime.runtimeLabel()
        val deviceName = devicesById[connectorId]?.name ?: connectorId.shortConnectorLabel()
        val metaParts = listOfNotNull(
            runtimeText,
            deviceName.takeIf { it.isNotBlank() },
            workspace.takeIf { it.isNotBlank() },
        )

        return AgentSession(
            id = id,
            connectorId = connectorId,
            deviceName = deviceName,
            title = displayTitle,
            summary = summaryText(statusValue, cwd, connectorStatus),
            cwd = cwd,
            workspaceLabel = workspace,
            runtime = runtime,
            runtimeLabel = runtimeText,
            status = statusValue,
            statusLabel = statusValue.statusLabel(),
            updatedAtLabel = activityAt.relativeTimeLabel(),
            metaLabel = metaParts.joinToString("  ·  "),
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

    private suspend fun mutateSessions(
        ids: List<String>,
        devices: List<AgentDevice>,
        fallbackMessage: String,
        request: (String, String, List<String>) -> RemoteSessionsMutationResponse,
    ): Result<SessionBatchUpdate> {
        val normalized = try {
            validatedSessionMutationIds(ids)
        } catch (error: IllegalArgumentException) {
            return Result.failure(error)
        }
        if (normalized.isEmpty()) {
            return Result.success(SessionBatchUpdate(emptyList(), emptyList(), null))
        }
        val auth = newSessionAuth()
            ?: return Result.failure(IllegalStateException("Sign in again to update sessions."))
        return withContext(Dispatchers.IO) {
            runCatching {
                val response = request(auth.serverUrl, auth.accessToken, normalized)
                val devicesById = devices.associateBy { it.id }
                SessionBatchUpdate(
                    sessions = response.sessions.map { it.toAgentSession(devicesById) },
                    notFound = response.notFound,
                    serverTime = response.serverTime,
                )
            }.wrapNewSessionFailure(fallbackMessage)
        }
    }

    private fun sessionComparator(): Comparator<RemoteSession> {
        return compareByDescending<RemoteSession> { it.sortAt.orEmpty() }
            .thenByDescending { it.lastActivityAt.orEmpty() }
            .thenByDescending { it.lastItemAt.orEmpty() }
            .thenByDescending { it.updatedSeq }
    }

    private fun summaryText(
        status: SessionStatus,
        cwd: String?,
        connectorStatus: String,
    ): String {
        return when {
            status == SessionStatus.WaitingApproval -> "Waiting for approval."
            status == SessionStatus.Running -> "Running now."
            status == SessionStatus.Error -> "Needs attention."
            !cwd.isNullOrBlank() -> cwd
            connectorStatus == "offline" -> "Device is offline."
            else -> "Ready for the next update."
        }
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

    private fun String.runtimeLabel(): String {
        return when (this) {
            "codex" -> "Codex"
            "claude" -> "Claude Code"
            "opencode" -> "OpenCode"
            "acp" -> "ACP"
            else -> replaceFirstChar { char ->
                if (char.isLowerCase()) char.titlecase() else char.toString()
            }
        }
    }

    private fun String?.workspaceName(): String {
        val trimmed = this?.trim()?.trimEnd('/') ?: return ""
        if (trimmed.isBlank()) return ""
        return trimmed.substringAfterLast('/').ifBlank { trimmed }
    }

    private fun String.shortConnectorLabel(): String {
        return take(8).ifBlank { "Device" }
    }

    private fun String?.relativeTimeLabel(): String {
        if (isNullOrBlank()) return ""
        val instant = try {
            Instant.parse(this)
        } catch (_: DateTimeParseException) {
            return ""
        }
        val elapsed = Duration.between(instant, Instant.now()).coerceAtLeast(Duration.ZERO)
        val minutes = elapsed.toMinutes()
        val hours = elapsed.toHours()
        val days = elapsed.toDays()
        return when {
            minutes < 1 -> "now"
            minutes < 60 -> "${minutes}m"
            hours < 24 -> "${hours}h"
            days == 1L -> "Yest."
            days < 7 -> "${days}d"
            days < 365 -> "${days / 7}w"
            else -> "${days / 365}y"
        }
    }

    private fun newSessionAuth(): NewSessionAuth? {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) return null
        return NewSessionAuth(serverUrl = serverUrl, accessToken = accessToken)
    }

    private fun <T> Result<T>.wrapNewSessionFailure(fallbackMessage: String): Result<T> {
        return recoverCatching { error ->
            if (error is ApiException) throw error
            throw IllegalStateException(error.message ?: fallbackMessage, error)
        }
    }

    private data class NewSessionAuth(
        val serverUrl: String,
        val accessToken: String,
    )
}

internal fun validateNewSessionDraft(draft: NewSessionCreateDraft): String? {
    if (draft.connectorId.isBlank()) return "Choose a connector before starting."
    if (draft.runtime !in setOf("codex", "claude")) return "Choose a supported runtime before starting."
    if (draft.content.isBlank() && draft.attachments.isEmpty()) return "Enter a message or attach a file before starting."
    if (draft.clientMessageId.isBlank()) return "The client message ID is missing."
    if (draft.attachments.size > MAX_CREATE_ATTACHMENTS) return "You can attach up to $MAX_CREATE_ATTACHMENTS files."
    draft.attachments.firstOrNull { it.name.isBlank() }?.let { return "An attachment name is missing." }
    draft.attachments.firstOrNull { it.bytes.isEmpty() }?.let { return "Attachments cannot be empty." }
    draft.attachments.firstOrNull { it.bytes.size > MAX_CREATE_ATTACHMENT_BYTES }?.let {
        return "Attachment ${it.name} is too large."
    }
    return null
}

internal fun NewSessionAttachmentPart.toInlineAttachmentRef(): RemoteInlineAttachmentRef {
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    val sha256 = digest.joinToString(separator = "") { byte -> "%02x".format(byte) }
    return RemoteInlineAttachmentRef(
        fileId = sha256,
        name = name,
        mediaType = mediaType.ifBlank { "application/octet-stream" },
        size = bytes.size.toLong(),
        sha256 = sha256,
        contentBase64 = Base64.getEncoder().encodeToString(bytes),
    )
}

private fun Throwable.mayHaveUnknownCreateOutcome(): Boolean {
    if (this !is ApiException || statusCode != null) return false
    return generateSequence<Throwable>(this) { it.cause }.any { it is IOException }
}

private fun Throwable.asCreateFailure(): Throwable {
    return if (this is ApiException) this else {
        IllegalStateException(message ?: "Could not create and start this session.", this)
    }
}

private const val MAX_CREATE_ATTACHMENTS = 10
private const val MAX_CREATE_ATTACHMENT_BYTES = 25 * 1024 * 1024

internal fun normalizeSessionIds(ids: List<String>): List<String> {
    return ids.distinct()
}

internal fun validatedSessionMutationIds(ids: List<String>): List<String> {
    val normalized = normalizeSessionIds(ids)
    require(normalized.size <= MAX_SESSION_MUTATION_IDS) {
        "At most $MAX_SESSION_MUTATION_IDS sessions can be updated at once."
    }
    return normalized
}

private const val MAX_SESSION_MUTATION_IDS = 200
