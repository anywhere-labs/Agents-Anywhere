package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.RemoteConnector
import com.agentsanywhere.app.api.RemoteSession
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException

class SessionsController(
    private val api: SessionsApi,
    private val sessionStore: AuthSessionStore,
) {
    suspend fun loadSessions(): Result<SessionsState> {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to load sessions."))
        }

        return withContext(Dispatchers.IO) {
            runCatching {
                val sessions = api.listSessions(
                    serverUrl = serverUrl,
                    authorizationToken = accessToken,
                )
                val connectors = api.listConnectors(
                    serverUrl = serverUrl,
                    authorizationToken = accessToken,
                )
                toState(sessions, connectors)
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

    suspend fun createSession(
        title: String,
        connectorId: String,
        runtime: String,
        cwd: String,
        devices: List<AgentDevice>,
    ): Result<AgentSession> {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to create a session."))
        }

        return withContext(Dispatchers.IO) {
            runCatching {
                api.createSession(
                    serverUrl = serverUrl,
                    authorizationToken = accessToken,
                    connectorId = connectorId,
                    runtime = runtime,
                    title = title.trim().takeIf { it.isNotBlank() },
                    cwd = cwd.trim().takeIf { it.isNotBlank() },
                ).toAgentSession(devices.associateBy { it.id })
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not create session.", error)
            }
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
                val directory = api.listConnectorFiles(
                    serverUrl = serverUrl,
                    authorizationToken = accessToken,
                    connectorId = connectorId,
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
                api.patchSession(
                    serverUrl = serverUrl,
                    authorizationToken = accessToken,
                    sessionId = sessionId,
                    title = title,
                    pinned = pinned,
                    archived = archived,
                ).toAgentSession(devices.associateBy { it.id })
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not update this session.", error)
            }
        }
    }

    private fun toState(
        remoteSessions: List<RemoteSession>,
        remoteConnectors: List<RemoteConnector>,
    ): SessionsState {
        val devicesById = remoteConnectors.associate { connector ->
            connector.id to connector.toAgentDevice()
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
            takeover = takeover,
            connectorOnline = connectorStatus == "online",
            effectiveRunMode = effectiveRunMode,
            runtimeSettings = runtimeSettings,
            runtimeSettingsOverride = runtimeSettingsOverride,
            live = statusValue == SessionStatus.Running || statusValue == SessionStatus.WaitingApproval,
            sortKey = sortAt ?: lastActivityAt ?: lastItemAt ?: "",
        )
    }

    private fun RemoteConnector.toAgentDevice(): AgentDevice {
        val runtimeCount = attachedRuntimes.size
        val subtitle = when {
            runtimeCount > 0 -> attachedRuntimes.joinToString(", ") { it.runtimeLabel() }
            status == "online" -> "Online"
            else -> "Offline"
        }
        return AgentDevice(
            id = id,
            name = name,
            deviceOs = deviceOs,
            subtitle = subtitle,
            online = status == "online",
            attachedRuntimes = attachedRuntimes,
            lastSeenAt = lastSeenAt,
            createdAt = createdAt,
        )
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
}
