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

val SessionsState.emptyKind: SessionsEmptyKind?
    get() {
        if (isLoading || errorMessage != null || sessions.isNotEmpty()) return null
        return if (devices.isEmpty()) SessionsEmptyKind.NoDevice else SessionsEmptyKind.NoSession
    }

enum class SessionsEmptyKind {
    NoSession,
    NoDevice,
}
