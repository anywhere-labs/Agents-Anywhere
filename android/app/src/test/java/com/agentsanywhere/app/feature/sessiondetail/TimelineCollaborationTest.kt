package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.SessionsApi
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TimelineCollaborationTest {
    private val api = SessionsApi()

    private fun item(id: String, type: String, role: String?, content: JSONObject, orderSeq: Int) = api.parseTimelineItem(
        JSONObject()
            .put("id", id)
            .put("sessionId", "sess_1")
            .put("type", type)
            .put("status", "done")
            .put("role", role ?: JSONObject.NULL)
            .put("content", content)
            .put("orderSeq", orderSeq)
            .put("revision", 1)
            .put("updatedSeq", orderSeq)
            .put("createdAt", "2026-11-18T10:00:0${orderSeq}Z"),
    )

    private fun project(vararg items: com.agentsanywhere.app.api.RemoteTimelineItem) =
        mergeRemoteTimelineItems(emptyList(), emptyList(), items.toList(), replace = true).messages.associateBy { it.id }

    @Test
    fun userMessageAuthorDecodesAgentAndSupervision() {
        val messages = project(
            item("u1", "message", "user", JSONObject().put("text", "do this").put("author", JSONObject().put("kind", "agent").put("sessionId", "sess_parent").put("deviceId", JSONObject.NULL).put("supervisionId", JSONObject.NULL)), 1),
            item("u2", "message", "user", JSONObject().put("text", "digest").put("author", JSONObject().put("kind", "supervision").put("sessionId", "sess_child").put("supervisionId", "sup_1")), 2),
            item("u3", "message", "user", JSONObject().put("text", "typed").put("author", JSONObject().put("kind", "robot")), 3),
            item("u4", "message", "user", JSONObject().put("text", "plain"), 4),
            item("a1", "message", "assistant", JSONObject().put("text", "reply").put("author", JSONObject().put("kind", "agent")), 5),
        )
        assertEquals(TimelineCollabAuthor(TimelineCollabAuthor.Kind.Agent, sessionId = "sess_parent"), messages.getValue("u1").collabAuthor)
        assertEquals(
            TimelineCollabAuthor(TimelineCollabAuthor.Kind.Supervision, sessionId = "sess_child", supervisionId = "sup_1"),
            messages.getValue("u2").collabAuthor,
        )
        assertEquals(MessageAuthor.User, messages.getValue("u2").author)
        assertNull(messages.getValue("u3").collabAuthor)
        assertNull(messages.getValue("u4").collabAuthor)
        assertNull(messages.getValue("a1").collabAuthor)
    }

    @Test
    fun escalationBecomesASystemCardWithItsQuestion() {
        val messages = project(
            item(
                "s1", "system", "system",
                JSONObject().put("kind", "collab_escalation").put("question", "Ship it?").put("context", "tests pass")
                    .put("fromSessionId", "sess_child").put("targetSessionId", JSONObject.NULL),
                1,
            ),
            item("s2", "system", "system", JSONObject().put("kind", "collab_escalation"), 2),
        )
        val card = messages.getValue("s1")
        assertEquals(TimelineMessageKind.System, card.kind)
        assertEquals("Ship it?", card.text)
        assertEquals(TimelineEscalation("Ship it?", "tests pass", "sess_child", null), card.escalation)
        // Without a question the item falls back to the ordinary system row.
        assertNull(messages.getValue("s2").escalation)
    }

    @Test
    fun collabToolDecodesKnownAndUnknownTools() {
        val messages = project(
            item("t1", "tool", "tool", JSONObject().put("kind", "mcp").put("server", "aa").put("tool", "aa_spawn").put("collabTool", JSONObject().put("tool", "aa_spawn").put("sessionId", "sess_child")), 1),
            item("t2", "tool", "tool", JSONObject().put("kind", "tool_call").put("collabTool", JSONObject().put("tool", "aa_future")), 2),
            item("t3", "tool", "tool", JSONObject().put("kind", "tool_call").put("collabTool", JSONObject()), 3),
        )
        assertEquals(TimelineCollabTool(CollabTool.Spawn, "aa_spawn", "sess_child"), messages.getValue("t1").collabTool)
        assertEquals(TimelineMessageKind.ToolCall, messages.getValue("t1").kind)
        assertEquals(TimelineCollabTool(null, "aa_future", null), messages.getValue("t2").collabTool)
        assertNull(messages.getValue("t3").collabTool)
    }

    @Test
    fun everyAgentToolHasAWireName() {
        assertEquals(
            listOf(
                "aa_spawn", "aa_send", "aa_steer", "aa_interrupt", "aa_status", "aa_read", "aa_wait",
                "aa_respond", "aa_plan_review", "aa_supervise", "aa_unsupervise", "aa_escalate", "aa_close",
            ),
            CollabTool.entries.map { it.wireValue },
        )
        CollabTool.entries.forEach { assertEquals(it, CollabTool.fromWire(it.wireValue)) }
        assertNull(CollabTool.fromWire("aa_unknown"))
    }
}
