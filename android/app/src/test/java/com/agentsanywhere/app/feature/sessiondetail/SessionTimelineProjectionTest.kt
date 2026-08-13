package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteTimelineItem
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionTimelineProjectionTest {
    @Test
    fun serverOrderingMatchesWebOrderSeqUpdatedSeqAndIdContract() {
        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(
                item("later", orderSeq = 20, updatedSeq = 1),
                item("same-z", orderSeq = 10, updatedSeq = 3),
                item("same-b", orderSeq = 10, updatedSeq = 2),
                item("same-a", orderSeq = 10, updatedSeq = 2),
            ),
            replace = true,
        )

        assertEquals(listOf("same-a", "same-b", "same-z", "later"), projection.messages.map { it.id })
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
        orderSeq: Int,
        updatedSeq: Int,
    ) = RemoteTimelineItem(
        id = id,
        sessionId = "session",
        type = "message",
        status = "done",
        role = "assistant",
        text = id,
        content = JSONObject().put("kind", "text").put("text", id),
        source = JSONObject(),
        orderSeq = orderSeq,
        revision = 1,
        updatedSeq = updatedSeq,
        createdAt = "now",
        updatedAt = null,
    )
}
