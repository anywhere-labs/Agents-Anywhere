package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.toProtocolJson
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.SessionOrigin
import com.agentsanywhere.app.model.SupervisionCreator
import com.agentsanywhere.app.model.SupervisionEdge
import com.agentsanywhere.app.model.SupervisionState
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionCollaborationTest {
    private val api = SessionsApi()

    private fun wire(id: String = "sess_1", title: String = "Child") = JSONObject()
        .put("id", id)
        .put("connectorId", "dev_1")
        .put("connectorStatus", "online")
        .put("runtime", "codex")
        .put("title", title)
        .put("status", "idle")

    private fun edge(
        supervisor: String,
        target: String = "sess_1",
        state: String = "active",
        createdBy: String = "agent",
        id: String = "sup_$supervisor",
    ) = JSONObject()
        .put("supervisionId", id)
        .put("supervisorSessionId", supervisor)
        .put("targetSessionId", target)
        .put("state", state)
        .put("createdBy", createdBy)

    private fun session(json: JSONObject) = api.parseSession(json).toAgentSession(emptyMap<String, AgentDevice>())

    @Test
    fun olderServersOmitCollaborationFields() {
        val parsed = api.parseSession(wire())
        assertNull(parsed.origin)
        assertTrue(parsed.supervisors.isEmpty())
        assertTrue(parsed.supervised.isEmpty())
        assertNull(session(wire()).collabIndicator)
        assertTrue(session(wire()).collaborationBadges { null }.isEmpty())
    }

    @Test
    fun originAndEdgesDecodeLeniently() {
        val json = wire()
            .put("origin", JSONObject().put("kind", "agent").put("bySessionId", "sess_parent").put("byDeviceId", "dev_2").put("depth", 2))
            .put(
                "supervisors",
                JSONArray()
                    .put(edge("sess_parent"))
                    .put(edge("sess_other", state = "frozen"))
                    .put(edge("sess_third", createdBy = "robot"))
                    .put(JSONObject().put("supervisionId", "broken"))
                    .put("not an object"),
            )
            .put("supervised", JSONObject.NULL)
        val parsed = api.parseSession(json)
        assertEquals(SessionOrigin("sess_parent", "dev_2", 2), parsed.origin)
        assertEquals(listOf("sess_parent", "sess_third"), parsed.supervisors.map { it.supervisorSessionId })
        assertEquals(SupervisionCreator.Agent, parsed.supervisors[0].createdBy)
        assertNull(parsed.supervisors[1].createdBy)
        assertTrue(parsed.supervised.isEmpty())

        assertNull(api.parseSession(wire().put("origin", JSONObject().put("kind", "human").put("bySessionId", "x"))).origin)
        assertNull(api.parseSession(wire().put("origin", JSONObject().put("kind", "agent"))).origin)
        assertNull(api.parseSession(wire().put("origin", "agent")).origin)
    }

    @Test
    fun collaborationFieldsSurviveTheSessionCache() {
        val json = wire()
            .put("origin", JSONObject().put("kind", "agent").put("bySessionId", "sess_parent").put("depth", 1))
            .put("supervisors", JSONArray().put(edge("sess_parent", state = "paused")))
            .put("supervised", JSONArray().put(edge("sess_1", target = "sess_child", createdBy = "human")))
        val parsed = api.parseSession(json)
        assertEquals(parsed, api.parseSession(parsed.toProtocolJson()))
    }

    @Test
    fun badgesNameRelatedSessionsAndOpenOnlyKnownOnes() {
        val parent = session(wire("sess_parent", "Parent"))
        val reviewer = session(wire("sess_reviewer", "Reviewer"))
        val child = session(
            wire()
                .put("origin", JSONObject().put("kind", "agent").put("bySessionId", "sess_parent").put("depth", 1))
                .put(
                    "supervisors",
                    JSONArray()
                        .put(edge("sess_gone", state = "ended"))
                        .put(edge("sess_reviewer", state = "ended", id = "old"))
                        .put(edge("sess_reviewer", state = "paused", id = "new"))
                        .put(edge("sess_parent")),
                ),
        )
        val lookup = sessionLookup(listOf(parent), listOf(reviewer))
        val badges = child.collaborationBadges(lookup)
        assertEquals(
            listOf(
                SessionCollabBadgeKind.CreatedBy to "sess_parent",
                SessionCollabBadgeKind.SupervisedBy to "sess_parent",
                SessionCollabBadgeKind.SupervisedBy to "sess_reviewer",
                SessionCollabBadgeKind.SupervisedBy to "sess_gone",
            ),
            badges.map { it.kind to it.sessionId },
        )
        assertEquals(listOf(null, SupervisionState.Active, SupervisionState.Paused, SupervisionState.Ended), badges.map { it.state })
        assertEquals(listOf("Parent", "Parent", "Reviewer", null), badges.map { it.title })
        assertSame(parent, badges[0].session)
        assertNull(badges[3].session)
    }

    @Test
    fun listIndicatorIgnoresEndedSupervision() {
        val created = session(wire().put("origin", JSONObject().put("kind", "agent").put("bySessionId", "p").put("depth", 1)))
        assertEquals(SessionCollabIndicator(agentCreated = true, supervised = false), created.collabIndicator)
        val ended = session(wire().put("supervisors", JSONArray().put(edge("p", state = "ended"))))
        assertNull(ended.collabIndicator)
        val paused = session(wire().put("supervisors", JSONArray().put(edge("p", state = "paused"))))
        assertEquals(SessionCollabIndicator(agentCreated = false, supervised = true), paused.collabIndicator)
        // Edges where this session is the supervisor do not mark it as supervised.
        val supervisor = session(wire().put("supervised", JSONArray().put(edge("sess_1", target = "c"))))
        assertNull(supervisor.collabIndicator)
        assertEquals(
            listOf(SupervisionEdge("sup_sess_1", "sess_1", "c", SupervisionState.Active, SupervisionCreator.Agent)),
            supervisor.supervised,
        )
    }
}
