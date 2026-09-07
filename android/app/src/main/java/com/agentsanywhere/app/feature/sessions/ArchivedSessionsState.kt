package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession

data class ArchivedSessionsState(
    val sessions: List<AgentSession> = emptyList(),
    val loading: Boolean = true,
    val loadingMore: Boolean = false,
    val error: String? = null,
    val hasMore: Boolean = false,
    val nextCursor: String? = null,
) {
    fun accept(page: SessionPageAppend, reset: Boolean, restoredIds: Set<String>): ArchivedSessionsState {
        val merged = (if (reset) emptyList() else sessions).associateBy { it.id }.toMutableMap()
        page.sessions.forEach { merged[it.id] = it }
        return copy(
            sessions = merged.values.filter { it.archived && it.id !in restoredIds }.sortedWith(archivedSessionComparator()),
            loading = false, loadingMore = false, error = null,
            hasMore = page.hasMore && !page.nextCursor.isNullOrBlank() && (reset || page.nextCursor != nextCursor),
            nextCursor = page.nextCursor,
        )
    }

}

data class ArchivedSessionGroup(val projectId: String?, val project: AgentProject?, val sessions: List<AgentSession>)

fun groupArchivedSessions(sessions: List<AgentSession>, projects: List<AgentProject>): List<ArchivedSessionGroup> {
    val projectById = projects.associateBy { it.id }
    val order = projects.mapIndexed { index, project -> project.id to index }.toMap()
    return sessions.sortedWith(archivedSessionComparator()).groupBy { it.projectId?.takeIf(String::isNotBlank) }
        .map { (id, items) -> ArchivedSessionGroup(id, projectById[id], items) }
        .sortedWith(compareBy<ArchivedSessionGroup> { it.projectId == null }
            .thenBy { order[it.projectId] ?: Int.MAX_VALUE }.thenBy { it.project?.name.orEmpty() })
}
