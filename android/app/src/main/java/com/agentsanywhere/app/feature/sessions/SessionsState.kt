package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession

data class SessionsState(
    val sessions: List<AgentSession> = emptyList(),
    val archivedSessions: List<AgentSession> = emptyList(),
    val devices: List<AgentDevice> = emptyList(),
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val hasLoaded: Boolean = false,
)

val SessionsState.pinnedSessions: List<AgentSession>
    get() = sessions.filter { it.pinned }

val SessionsState.recentSessions: List<AgentSession>
    get() = sessions.filterNot { it.pinned }

fun SessionsState.withPatchedSession(session: AgentSession): SessionsState {
    val nextSessions = if (session.archived) {
        sessions.filterNot { it.id == session.id }
    } else {
        val hadSession = sessions.any { it.id == session.id }
        val merged = if (hadSession) {
            sessions.map { current -> if (current.id == session.id) session else current }
        } else {
            sessions + session
        }
        merged.sortedWith(
            compareByDescending<AgentSession> { it.pinned }
                .thenByDescending { it.sortKey },
        )
    }
    val nextArchivedSessions = if (session.archived) {
        val hadSession = archivedSessions.any { it.id == session.id }
        val merged = if (hadSession) {
            archivedSessions.map { current -> if (current.id == session.id) session else current }
        } else {
            archivedSessions + session
        }
        merged.sortedByDescending { it.sortKey }
    } else {
        archivedSessions.filterNot { it.id == session.id }
    }

    return copy(
        sessions = nextSessions,
        archivedSessions = nextArchivedSessions,
        isLoading = false,
        errorMessage = null,
        hasLoaded = true,
    )
}

fun SessionsState.withPatchedDevice(device: AgentDevice): SessionsState {
    val nextDevices = devices
        .map { current -> if (current.id == device.id) device else current }
        .sortedBy { it.name.lowercase() }

    return copy(
        devices = nextDevices,
        sessions = sessions.map { session -> session.withDeviceInfo(device) },
        archivedSessions = archivedSessions.map { session -> session.withDeviceInfo(device) },
        isLoading = false,
        errorMessage = null,
        hasLoaded = true,
    )
}

fun SessionsState.withDeletedDevice(deviceId: String): SessionsState {
    return copy(
        devices = devices.filterNot { it.id == deviceId },
        sessions = sessions.filterNot { it.connectorId == deviceId },
        archivedSessions = archivedSessions.filterNot { it.connectorId == deviceId },
        isLoading = false,
        errorMessage = null,
        hasLoaded = true,
    )
}

fun SessionsState.withDeletedDeviceAgent(
    deviceId: String,
    runtime: String,
    attachedRuntimes: List<String>,
): SessionsState {
    return copy(
        devices = devices.map { device ->
            if (device.id == deviceId) device.copy(attachedRuntimes = attachedRuntimes) else device
        },
        sessions = sessions.filterNot { it.connectorId == deviceId && it.runtime == runtime },
        archivedSessions = archivedSessions.filterNot { it.connectorId == deviceId && it.runtime == runtime },
        isLoading = false,
        errorMessage = null,
        hasLoaded = true,
    )
}

private fun AgentSession.withDeviceInfo(device: AgentDevice): AgentSession {
    if (connectorId != device.id) return this
    val parts = metaLabel
        .split("  ·  ")
        .toMutableList()
    if (parts.size >= 2) {
        parts[1] = device.name
    }
    return copy(
        deviceName = device.name,
        connectorOnline = device.online,
        metaLabel = parts.joinToString("  ·  "),
    )
}

val SessionsState.emptyKind: SessionsEmptyKind?
    get() {
        if (isLoading || errorMessage != null || sessions.isNotEmpty()) return null
        return if (devices.isEmpty()) SessionsEmptyKind.NoDevice else SessionsEmptyKind.NoSession
    }

enum class SessionsEmptyKind {
    NoSession,
    NoDevice,
}
