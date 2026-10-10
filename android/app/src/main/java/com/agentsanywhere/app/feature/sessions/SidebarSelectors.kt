package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import java.time.Instant

internal fun timestampMillis(value: String?): Long =
    value?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrDefault(0L) } ?: 0L

/**
 * Statuses that mean "the Agent is still working on (or blocked in) this
 * session". Shared by the list order, the in-progress view and the project
 * status filter so a session never jumps between groups while its status
 * flaps between e.g. running and waiting_approval.
 */
/**
 * Sessions the runtime syncs only so their full conversation can be opened
 * from the parent (DSH teammates and one-shot subagents). They never appear
 * in the main lists; the parent's timeline links to them directly.
 */
fun sessionIsLinkedSubagent(session: AgentSession): Boolean =
    session.sourceAvailability == "unavailable" &&
        session.sourceAvailabilityReason == "dsh_subagent"

fun sessionIsWorking(session: AgentSession, now: Long = System.currentTimeMillis()): Boolean =
    session.status in setOf(
        SessionStatus.Running,
        SessionStatus.Waiting,
        SessionStatus.Pending,
        SessionStatus.Stopping,
        SessionStatus.WaitingApproval,
        SessionStatus.Blocked,
    ) || session.optimisticTopUntil > now

fun sessionListComparator(now: Long = System.currentTimeMillis()): Comparator<AgentSession> = Comparator { left, right ->
    val pinned = right.pinned.compareTo(left.pinned)
    val leftWorking = sessionIsWorking(left, now)
    val rightWorking = sessionIsWorking(right, now)
    when {
        pinned != 0 -> pinned
        leftWorking != rightWorking -> if (leftWorking) -1 else 1
        // Inside the working group the order is pinned by id: status flips and
        // background syncs never reshuffle sessions that are still working.
        leftWorking -> left.id.compareTo(right.id)
        // Settled sessions sort by the last user-visible item time so
        // sync-only sortAt bumps cannot reshuffle the list either.
        else -> timestampMillis(right.recencyKey).compareTo(timestampMillis(left.recencyKey))
            .takeIf { it != 0 } ?: timestampMillis(right.sortKey).compareTo(timestampMillis(left.sortKey))
            .takeIf { it != 0 } ?: right.id.compareTo(left.id)
    }
}

fun archivedSessionComparator(): Comparator<AgentSession> =
    compareByDescending<AgentSession> { timestampMillis(it.archivedAt ?: it.sortKey) }.thenBy { it.id }

enum class ProjectSessionStatusFilter(val archiveStates: List<Boolean>) {
    Active(listOf(false)),
    Archived(listOf(true)),
    All(listOf(false, true)),
    // Only sessions a device Agent is actively working on (or blocked in).
    Working(listOf(false)),
}

data class ProjectSessionLoadKey(val projectId: String, val archived: Boolean)

data class ProjectDeviceAgentFilter(
    val connectorId: String? = null,
    val runtime: String? = null,
) {
    val active: Boolean get() = connectorId != null || runtime != null

    fun matches(session: AgentSession): Boolean =
        (connectorId == null || session.connectorId == connectorId) &&
            (runtime == null || session.runtime == runtime)
}

fun projectSessionMatchesStatus(session: AgentSession, status: ProjectSessionStatusFilter): Boolean = when (status) {
    ProjectSessionStatusFilter.Active -> !session.archived && !session.pinned
    ProjectSessionStatusFilter.Archived -> session.archived
    ProjectSessionStatusFilter.All -> session.archived || !session.pinned
    ProjectSessionStatusFilter.Working -> !session.archived && sessionIsWorking(session)
}

fun projectHasVisibleSessions(
    project: AgentProject,
    sessions: Collection<AgentSession>,
    status: ProjectSessionStatusFilter,
    filter: ProjectDeviceAgentFilter = ProjectDeviceAgentFilter(),
): Boolean {
    if (filter.active) {
        if (filter.connectorId != null && project.connectorId != filter.connectorId) return false
        return sessions.any { session ->
            session.projectId == project.id && projectSessionMatchesStatus(session, status) && filter.matches(session)
        }
    }
    return project.manuallyCreated || (project.sidebarSessionCounts?.let { counts ->
        when (status) {
            ProjectSessionStatusFilter.Active -> counts.active > 0
            ProjectSessionStatusFilter.Archived -> counts.archived > 0
            ProjectSessionStatusFilter.All -> counts.active + counts.archived > 0
            // Server-side counts cannot name working sessions; be exact when
            // the project's sessions are loaded and optimistic otherwise.
            ProjectSessionStatusFilter.Working ->
                if (sessions.any { it.projectId == project.id }) {
                    sessions.any { it.projectId == project.id && !it.archived && sessionIsWorking(it) }
                } else {
                    counts.active > 0
                }
        }
    } ?: sessions.any { it.projectId == project.id && projectSessionMatchesStatus(it, status) })
}

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
