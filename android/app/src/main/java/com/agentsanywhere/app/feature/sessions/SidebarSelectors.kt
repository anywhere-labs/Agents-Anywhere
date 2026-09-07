package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import java.time.Instant

internal fun timestampMillis(value: String?): Long =
    value?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrDefault(0L) } ?: 0L

fun sessionListComparator(now: Long = System.currentTimeMillis()): Comparator<AgentSession> = Comparator { left, right ->
    val pinned = right.pinned.compareTo(left.pinned)
    val leftRunning = left.status == SessionStatus.Running || left.optimisticTopUntil > now
    val rightRunning = right.status == SessionStatus.Running || right.optimisticTopUntil > now
    when {
        pinned != 0 -> pinned
        leftRunning != rightRunning -> if (leftRunning) -1 else 1
        leftRunning -> left.id.compareTo(right.id)
        else -> timestampMillis(right.sortKey).compareTo(timestampMillis(left.sortKey))
            .takeIf { it != 0 } ?: right.id.compareTo(left.id)
    }
}

fun archivedSessionComparator(): Comparator<AgentSession> =
    compareByDescending<AgentSession> { timestampMillis(it.archivedAt ?: it.sortKey) }.thenBy { it.id }

enum class ProjectSessionStatusFilter(val archiveStates: List<Boolean>) {
    Active(listOf(false)),
    Archived(listOf(true)),
    All(listOf(false, true)),
}

data class ProjectSessionLoadKey(val projectId: String, val archived: Boolean)

fun projectSessionMatchesStatus(session: AgentSession, status: ProjectSessionStatusFilter): Boolean = when (status) {
    ProjectSessionStatusFilter.Active -> !session.archived && !session.pinned
    ProjectSessionStatusFilter.Archived -> session.archived
    ProjectSessionStatusFilter.All -> session.archived || !session.pinned
}

fun projectHasVisibleSessions(
    project: AgentProject,
    sessions: Collection<AgentSession>,
    status: ProjectSessionStatusFilter,
): Boolean = project.manuallyCreated || (project.sidebarSessionCounts?.let { counts ->
    when (status) {
        ProjectSessionStatusFilter.Active -> counts.active > 0
        ProjectSessionStatusFilter.Archived -> counts.archived > 0
        ProjectSessionStatusFilter.All -> counts.active + counts.archived > 0
    }
} ?: sessions.any { it.projectId == project.id && projectSessionMatchesStatus(it, status) })

fun projectHasActiveSessions(project: AgentProject, sessions: Collection<AgentSession>): Boolean =
    projectHasVisibleSessions(project, sessions, ProjectSessionStatusFilter.Active)

fun sortProjectsByActivity(projects: List<AgentProject>, sessions: Collection<AgentSession>): List<AgentProject> {
    val activity = sessions.filter { !it.projectId.isNullOrBlank() }.groupBy { it.projectId }
        .mapValues { (_, items) -> items.maxOf { timestampMillis(it.sortKey) } }
    fun empty(project: AgentProject) = project.manuallyCreated && project.lastActivityAt.isNullOrBlank()
        && project.id !in activity && project.activeSessionCount == 0
        && (project.sidebarSessionCounts?.active ?: 0) == 0 && (project.sidebarSessionCounts?.archived ?: 0) == 0
    return projects.sortedWith(
        compareByDescending<AgentProject> { empty(it) }
            .thenByDescending { maxOf(timestampMillis(it.lastActivityAt), activity[it.id] ?: 0L) }
            .thenByDescending { timestampMillis(it.createdAt) }
            .thenBy { it.name }.thenBy { it.id },
    )
}
