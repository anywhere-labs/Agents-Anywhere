package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SupervisionState

enum class SessionCollabBadgeKind {
    /** The session was created by the Agent of [SessionCollabBadge.sessionId]. */
    CreatedBy,

    /** [SessionCollabBadge.sessionId] supervises this session. */
    SupervisedBy,
}

/**
 * One header badge of a session page. [session] is the related session when it is
 * in the loaded lists; only then can the badge open it. [title] is null when the
 * related session is unknown here.
 */
data class SessionCollabBadge(
    val kind: SessionCollabBadgeKind,
    val sessionId: String,
    val title: String?,
    val state: SupervisionState? = null,
    val session: AgentSession? = null,
)

/** Header badges: the creator first, then one badge per supervisor (active, paused, ended). */
fun AgentSession.collaborationBadges(lookup: (String) -> AgentSession?): List<SessionCollabBadge> {
    val badges = mutableListOf<SessionCollabBadge>()
    origin?.let { origin ->
        val creator = lookup(origin.bySessionId)
        badges += SessionCollabBadge(
            kind = SessionCollabBadgeKind.CreatedBy,
            sessionId = origin.bySessionId,
            title = creator?.title,
            session = creator,
        )
    }
    supervisors
        .filter { it.targetSessionId == id && it.supervisorSessionId != id }
        .groupBy { it.supervisorSessionId }
        // SupervisionState is declared active, paused, ended: the lowest ordinal is the liveliest edge.
        .map { (supervisorId, edges) -> supervisorId to edges.minBy { it.state.ordinal }.state }
        .sortedBy { (_, state) -> state.ordinal }
        .forEach { (supervisorId, state) ->
            val supervisor = lookup(supervisorId)
            badges += SessionCollabBadge(
                kind = SessionCollabBadgeKind.SupervisedBy,
                sessionId = supervisorId,
                title = supervisor?.title,
                state = state,
                session = supervisor,
            )
        }
    return badges
}

/** Session list marks: created by an Agent, and supervised by a session that has not ended it. */
data class SessionCollabIndicator(
    val agentCreated: Boolean,
    val supervised: Boolean,
)

val AgentSession.collabIndicator: SessionCollabIndicator?
    get() {
        val agentCreated = origin != null
        val supervised = supervisors.any { it.targetSessionId == id && it.state != SupervisionState.Ended }
        return if (agentCreated || supervised) SessionCollabIndicator(agentCreated, supervised) else null
    }

/** Finds a session by id across the given lists; the first list wins. */
fun sessionLookup(vararg lists: Collection<AgentSession>): (String) -> AgentSession? {
    val byId = HashMap<String, AgentSession>()
    lists.forEach { list -> list.forEach { session -> byId.putIfAbsent(session.id, session) } }
    return { id -> byId[id] }
}
