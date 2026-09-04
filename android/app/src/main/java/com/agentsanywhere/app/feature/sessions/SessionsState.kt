package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession

data class SessionsState(
    val sessions: List<AgentSession> = emptyList(),
    val archivedSessions: List<AgentSession> = emptyList(),
    val projects: List<AgentProject> = emptyList(),
    val devices: List<AgentDevice> = emptyList(),
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val hasLoaded: Boolean = false,
    val activeHasMore: Boolean = false,
    val activeNextCursor: String? = null,
    val archivedHasMore: Boolean = false,
    val archivedNextCursor: String? = null,
    val isLoadingMoreActive: Boolean = false,
    val isLoadingMoreArchived: Boolean = false,
    val activeFirstPageIds: Set<String> = emptySet(),
    val archivedFirstPageIds: Set<String> = emptySet(),
    val sessionRequestGenerations: Map<String, Long> = emptyMap(),
    val nextRequestGeneration: Long = 1L,
)

data class SessionRequestStart(
    val state: SessionsState,
    val generation: Long,
)

data class SessionBatchUpdate(
    val sessions: List<AgentSession>,
    val notFound: List<String>,
    val serverTime: String?,
)

data class SessionPageAppend(
    val sessions: List<AgentSession>,
    val archived: Boolean,
    val hasMore: Boolean,
    val nextCursor: String?,
)

val SessionsState.pinnedSessions: List<AgentSession>
    get() = sessions.filter { it.pinned }

val SessionsState.recentSessions: List<AgentSession>
    get() = sessions.filterNot { it.pinned }

val SessionsState.pinnedProjects: List<AgentProject>
    get() = projects.filter { it.pinned }

val SessionsState.unpinnedProjects: List<AgentProject>
    get() = projects.filterNot { it.pinned }

fun SessionsState.withPatchedProject(project: AgentProject): SessionsState {
    val nextProjects = if (projects.any { it.id == project.id }) {
        projects.map { current -> if (current.id == project.id) project else current }
    } else {
        projects + project
    }
    return copy(
        projects = nextProjects.sortedWith(projectComparator()),
        isLoading = false,
        errorMessage = null,
        hasLoaded = true,
    )
}

fun SessionsState.beginSessionRequest(ids: Collection<String> = emptyList()): SessionRequestStart {
    val generation = nextRequestGeneration
    val nextGenerations = if (ids.isEmpty()) {
        sessionRequestGenerations
    } else {
        sessionRequestGenerations + ids.associateWith { generation }
    }
    return SessionRequestStart(
        state = copy(
            sessionRequestGenerations = nextGenerations,
            nextRequestGeneration = generation + 1,
        ),
        generation = generation,
    )
}

fun mergeObservedSession(current: AgentSession?, incoming: AgentSession): AgentSession {
    if (current == null || current.id != incoming.id) return incoming
    val base = if (incoming.updatedSeq >= current.updatedSeq) incoming else current
    val lastReadSeq = maxOf(current.lastReadSeq, incoming.lastReadSeq)
    return base.copy(
        title = current.title,
        pinned = current.pinned,
        archived = current.archived,
        unread = lastReadSeq < base.updatedSeq,
        lastReadSeq = lastReadSeq,
    )
}

fun mergeAuthoritativeSessionMetadata(current: AgentSession?, incoming: AgentSession): AgentSession {
    if (current == null || current.id != incoming.id) return incoming
    val base = if (incoming.updatedSeq >= current.updatedSeq) incoming else current
    val lastReadSeq = maxOf(current.lastReadSeq, incoming.lastReadSeq)
    return base.copy(
        title = incoming.title,
        pinned = incoming.pinned,
        archived = incoming.archived,
        unread = lastReadSeq < base.updatedSeq,
        lastReadSeq = lastReadSeq,
    )
}

fun SessionsState.withPatchedSession(
    session: AgentSession,
    generation: Long? = null,
): SessionsState {
    val current = sessions.firstOrNull { it.id == session.id }
        ?: archivedSessions.firstOrNull { it.id == session.id }
    val currentGeneration = sessionRequestGenerations[session.id] ?: 0L
    if (generation != null && currentGeneration > generation) return this
    val accepted = if (generation == null) {
        mergeObservedSession(current, session)
    } else {
        mergeAuthoritativeSessionMetadata(current, session)
    }

    val nextSessions = if (accepted.archived) {
        sessions.filterNot { it.id == accepted.id }
    } else {
        val hadSession = sessions.any { it.id == accepted.id }
        val merged = if (hadSession) {
            sessions.map { existing -> if (existing.id == accepted.id) accepted else existing }
        } else {
            sessions + accepted
        }
        merged.sortedWith(
            compareByDescending<AgentSession> { it.pinned }
                .thenByDescending { it.sortKey },
        )
    }
    val nextArchivedSessions = if (accepted.archived) {
        val hadSession = archivedSessions.any { it.id == accepted.id }
        val merged = if (hadSession) {
            archivedSessions.map { existing -> if (existing.id == accepted.id) accepted else existing }
        } else {
            archivedSessions + accepted
        }
        merged.sortedByDescending { it.sortKey }
    } else {
        archivedSessions.filterNot { it.id == accepted.id }
    }

    return copy(
        sessions = nextSessions,
        archivedSessions = nextArchivedSessions,
        isLoading = false,
        errorMessage = null,
        hasLoaded = true,
        sessionRequestGenerations = if (generation == null) {
            sessionRequestGenerations
        } else {
            sessionRequestGenerations + (accepted.id to generation)
        },
    )
}

fun SessionsState.withPatchedSessions(
    updated: List<AgentSession>,
    generation: Long? = null,
): SessionsState {
    return updated.fold(this) { state, session -> state.withPatchedSession(session, generation) }
}

fun SessionsState.withMissingSessionsRemoved(
    ids: Collection<String>,
    generation: Long? = null,
): SessionsState {
    if (ids.isEmpty()) return this
    val missing = ids.filter { id ->
        generation == null || (sessionRequestGenerations[id] ?: 0L) <= generation
    }.toSet()
    return copy(
        sessions = sessions.filterNot { it.id in missing },
        archivedSessions = archivedSessions.filterNot { it.id in missing },
        sessionRequestGenerations = sessionRequestGenerations - missing,
    )
}

fun SessionsState.mergedWithRefresh(
    loaded: SessionsState,
    generation: Long,
): SessionsState {
    val currentById = (sessions + archivedSessions).associateBy { it.id }
    val loadedById = (loaded.sessions + loaded.archivedSessions).associateBy { it.id }
    val mergedLoaded = loadedById.values.map { incoming ->
        val current = currentById[incoming.id]
        val currentGeneration = sessionRequestGenerations[incoming.id] ?: 0L
        if (current != null && currentGeneration > generation) current else incoming
    }
    val createdAfterRefresh = currentById.values.filter { current ->
        current.id !in loadedById && (sessionRequestGenerations[current.id] ?: 0L) > generation
    }
    val merged = mergedLoaded + createdAfterRefresh
    val nextGenerations = merged.associate { session ->
        val currentGeneration = sessionRequestGenerations[session.id] ?: 0L
        session.id to maxOf(currentGeneration, generation)
    }
    return loaded.copy(
        sessions = emptyList(),
        archivedSessions = emptyList(),
        sessionRequestGenerations = nextGenerations,
        nextRequestGeneration = maxOf(nextRequestGeneration, generation + 1),
    ).withPatchedSessions(merged)
}

fun SessionsState.replacedByDashboardSnapshot(loaded: SessionsState): SessionsState {
    val currentById = (sessions + archivedSessions).associateBy { it.id }
    val replacedFirstPageIds = activeFirstPageIds + archivedFirstPageIds
    val preserved = currentById.values.filterNot { it.id in replacedFirstPageIds }
    val accepted = (preserved + loaded.sessions + loaded.archivedSessions).map { incoming ->
        currentById[incoming.id]?.takeIf { current -> current.updatedSeq > incoming.updatedSeq } ?: incoming
    }.associateBy { it.id }.values
    return loaded.copy(
        sessions = accepted
            .filterNot { it.archived }
            .sortedWith(compareByDescending<AgentSession> { it.pinned }.thenByDescending { it.sortKey }),
        archivedSessions = accepted.filter { it.archived }.sortedByDescending { it.sortKey },
        sessionRequestGenerations = sessionRequestGenerations,
        nextRequestGeneration = nextRequestGeneration,
    )
}

fun SessionsState.withSessionPageLoading(archived: Boolean, loading: Boolean): SessionsState {
    return if (archived) {
        copy(isLoadingMoreArchived = loading)
    } else {
        copy(isLoadingMoreActive = loading)
    }
}

fun SessionsState.withAppendedSessionPage(page: SessionPageAppend): SessionsState {
    val currentById = (sessions + archivedSessions).associateBy { it.id }.toMutableMap()
    page.sessions.forEach { incoming ->
        currentById[incoming.id] = mergeObservedSession(currentById[incoming.id], incoming)
    }
    val all = currentById.values
    return copy(
        sessions = all.filterNot { it.archived }
            .sortedWith(compareByDescending<AgentSession> { it.pinned }.thenByDescending { it.sortKey }),
        archivedSessions = all.filter { it.archived }.sortedByDescending { it.sortKey },
        activeHasMore = if (page.archived) activeHasMore else page.hasMore,
        activeNextCursor = if (page.archived) activeNextCursor else page.nextCursor,
        archivedHasMore = if (page.archived) page.hasMore else archivedHasMore,
        archivedNextCursor = if (page.archived) page.nextCursor else archivedNextCursor,
        isLoadingMoreActive = if (page.archived) isLoadingMoreActive else false,
        isLoadingMoreArchived = if (page.archived) false else isLoadingMoreArchived,
    )
}

fun SessionsState.withPatchedDevice(device: AgentDevice): SessionsState {
    val hadDevice = devices.any { it.id == device.id }
    val nextDevices = if (hadDevice) {
        devices.map { current -> if (current.id == device.id) device else current }
    } else {
        devices + device
    }.sortedBy { it.name.lowercase() }

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
        projects = projects.filterNot { it.connectorId == deviceId },
        sessions = sessions.filterNot { it.connectorId == deviceId },
        archivedSessions = archivedSessions.filterNot { it.connectorId == deviceId },
        isLoading = false,
        errorMessage = null,
        hasLoaded = true,
    )
}

private fun projectComparator(): Comparator<AgentProject> {
    return compareByDescending<AgentProject> { it.pinned }
        .thenByDescending { it.pinnedAt.orEmpty() }
        .thenByDescending { it.lastActivityAt.orEmpty() }
        .thenByDescending { it.updatedAt }
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
