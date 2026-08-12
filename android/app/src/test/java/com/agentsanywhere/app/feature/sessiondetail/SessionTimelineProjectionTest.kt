package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteTimelineItem
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class SessionTimelineProjectionTest {
    @Test
    fun turnBoundaryAnchorsInvisibleRowsAndLateItemsStayInTheirTurn() {
        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(
                item("turn-a-start", "turn.start", "turn-a", 1),
                item("turn-b-start", "turn.start", "turn-b", 2),
                item("reply-b", "message", "turn-b", 3, "reply b"),
                item("late-a", "system", "turn-a", 4, contentKind = "reasoning"),
            ),
            replace = true,
        )

        assertEquals(listOf("late-a", "reply-b"), projection.messages.map { it.id })
        assertFalse(projection.messages.any { it.sourceItemId.endsWith("start") })
        assertEquals(4, projection.orderingItems.size)
    }

    @Test
    fun serverEchoReplacesOptimisticMessageWithoutChangingBlockOrder() {
        val optimistic = TimelineMessage(
            id = "client-1",
            author = MessageAuthor.User,
            text = "pending",
            orderSeq = 2,
            updatedSeq = 2,
            clientMessageId = "client-1",
            optimistic = true,
        )
        val echo = TimelineMessage(
            id = "server-1",
            author = MessageAuthor.User,
            text = "confirmed",
            orderSeq = 2,
            updatedSeq = 3,
            clientMessageId = "client-1",
        )

        val merged = mergeOptimisticTimelineMessages(listOf(echo), listOf(optimistic), emptyList(), emptyList())

        assertEquals(listOf("server-1"), merged.messages.map { it.id })
        assertEquals(emptyList<TimelineMessage>(), merged.pending)
    }

    private fun item(
        id: String,
        type: String,
        turnId: String?,
        orderSeq: Int,
        text: String = "",
        contentKind: String = "text",
    ) = RemoteTimelineItem(
        id = id,
        sessionId = "session",
        turnId = turnId,
        type = type,
        status = "done",
        role = if (type == "message") "assistant" else null,
        text = text,
        content = JSONObject().put("kind", contentKind).put("text", "reasoning"),
        source = JSONObject(),
        orderSeq = orderSeq,
        revision = 1,
        updatedSeq = orderSeq,
        createdAt = "now",
        updatedAt = null,
    )
}
