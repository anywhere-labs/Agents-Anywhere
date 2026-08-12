package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.RemoteSessionEventPayload
import com.agentsanywhere.app.api.RemoteTimelineItem
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class SessionDetailReducerTest {
    @Test
    fun batchDeduplicatesEventsAndAdvancesCursorMonotonically() {
        val initial = SessionDetailState(meta = SessionMeta(session = session()), initialized = true)
        val first = event("event-1", 2, "first")
        val duplicate = first.copy(cursor = "seq:1")
        val second = event("event-2", 3, "second")

        val reduced = reduceRealtimeEvents(initial, listOf(first, duplicate, second), emptyList())

        assertEquals(listOf("first", "second"), reduced.messages.map { it.text })
        assertEquals(setOf("event-1", "event-2"), reduced.realtime.processedEventIds)
        assertEquals("seq:3", reduced.realtime.cursor)
        assertSame(reduced, reduceRealtimeEvent(reduced, second, emptyList()))
    }

    private fun event(id: String, sequence: Int, text: String) = RemoteSessionEventEnvelope(
        protocolVersion = "1.0",
        eventId = id,
        sequence = sequence.toLong(),
        cursor = "seq:$sequence",
        type = "timeline.item_created",
        sessionId = "session",
        emittedAt = "now",
        payload = RemoteSessionEventPayload(
            item = RemoteTimelineItem(
                id = id,
                sessionId = "session",
                type = "message",
                status = "done",
                role = "assistant",
                text = text,
                content = JSONObject().put("kind", "text"),
                source = JSONObject(),
                orderSeq = sequence,
                revision = 1,
                updatedSeq = sequence,
                createdAt = "now",
                updatedAt = null,
            ),
        ),
    )

    private fun session() = AgentSession(
        id = "session",
        connectorId = "connector",
        deviceName = "Device",
        title = "Session",
        summary = "",
        cwd = null,
        workspaceLabel = "",
        runtime = "codex",
        runtimeLabel = "Codex",
        status = SessionStatus.Idle,
        statusLabel = "Idle",
        updatedAtLabel = "",
        metaLabel = "",
        pinned = false,
        archived = false,
        unread = false,
        lastReadSeq = 0,
        takeover = false,
        connectorOnline = true,
        live = false,
        sortKey = "",
        updatedSeq = 0,
    )
}
