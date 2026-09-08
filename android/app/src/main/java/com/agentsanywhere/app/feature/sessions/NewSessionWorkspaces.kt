package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import java.text.Collator

internal fun recentWorkspacePaths(
    connectorId: String?,
    deviceOs: String?,
    homePath: String?,
    sessions: List<AgentSession>,
    projects: List<AgentProject>,
    now: Long = System.currentTimeMillis(),
): List<String> {
    if (connectorId.isNullOrBlank()) return emptyList()

    val sessionsById = mutableMapOf<String, AgentSession>()
    for (session in sessions) {
        if (session.connectorId != connectorId) continue
        val current = sessionsById[session.id]
        val latest = if (current == null || session.updatedSeq >= current.updatedSeq) session else current
        sessionsById[session.id] = latest.copy(
            optimisticTopUntil = maxOf(current?.optimisticTopUntil ?: 0L, session.optimisticTopUntil),
        )
    }

    // Match Desktop's combined session order before keeping the first occurrence of each CWD.
    val sessionPaths = sessionsById.values.sortedWith(workspaceSessionComparator(now)).mapNotNull { it.cwd }
    val projectPaths = projects.filter { it.connectorId == connectorId }
        .sortedWith(workspaceProjectComparator()).map { it.workspacePath }
    val homeKey = workspacePathKey(homePath.orEmpty(), deviceOs)
    return (sessionPaths + projectPaths)
        .filter(String::isNotBlank)
        .distinctBy { workspacePathKey(it, deviceOs) }
        .filterNot { workspacePathKey(it, deviceOs) == homeKey }
}

private fun workspaceSessionComparator(now: Long): Comparator<AgentSession> = Comparator { left, right ->
    val leftRunning = left.status == SessionStatus.Running || left.optimisticTopUntil > now
    val rightRunning = right.status == SessionStatus.Running || right.optimisticTopUntil > now
    when {
        leftRunning != rightRunning -> if (leftRunning) -1 else 1
        leftRunning -> left.id.compareTo(right.id)
        else -> timestampMillis(right.sortAt).compareTo(timestampMillis(left.sortAt))
            .takeIf { it != 0 } ?: right.id.compareTo(left.id)
    }
}

private fun workspaceProjectComparator(): Comparator<AgentProject> {
    val collator = Collator.getInstance()
    return compareByDescending<AgentProject> { it.pinned }
        .thenByDescending {
            timestampMillis(it.pinnedAt?.takeIf(String::isNotEmpty)
                ?: it.lastActivityAt?.takeIf(String::isNotEmpty) ?: it.updatedAt)
        }
        .thenComparator { left, right ->
            collator.compare(left.name, right.name).takeIf { it != 0 }
                ?: collator.compare(left.id, right.id)
        }
}
