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

fun projectHasActiveSessions(project: AgentProject, sessions: Collection<AgentSession>): Boolean =
    project.manuallyCreated || (project.sidebarSessionCounts?.let { it.active > 0 }
        ?: sessions.any { it.projectId == project.id && !it.archived && !it.pinned })

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
