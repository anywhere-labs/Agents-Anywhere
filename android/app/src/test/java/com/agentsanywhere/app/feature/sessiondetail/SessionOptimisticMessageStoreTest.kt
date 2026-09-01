package com.agentsanywhere.app.feature.sessiondetail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionOptimisticMessageStoreTest {
    @Test
    fun moveTransfersPendingMessagesToServerSession() {
        val store = SessionOptimisticMessageStore()
        store.upsert("local-session", optimisticMessage(id = "message-1", orderSeq = 1))

        store.move("local-session", "server-session")

        assertTrue(store.read("local-session").isEmpty())
        assertEquals(listOf("message-1"), store.read("server-session").map(TimelineMessage::id))
    }

    @Test
    fun moveDeduplicatesMessagesAlreadyStoredForServerSession() {
        val store = SessionOptimisticMessageStore()
        store.upsert("server-session", optimisticMessage(id = "message-1", orderSeq = 1, status = "pending"))
        store.upsert("local-session", optimisticMessage(id = "message-1", orderSeq = 1, status = "running"))

        store.move("local-session", "server-session")

        val messages = store.read("server-session")
        assertEquals(1, messages.size)
        assertEquals("running", messages.single().status)
    }

    @Test
    fun movedMessageIsReplacedByMatchingServerEcho() {
        val store = SessionOptimisticMessageStore()
        store.upsert("local-session", optimisticMessage(id = "message-1", orderSeq = 1))
        store.move("local-session", "server-session")
        val serverMessage = TimelineMessage(
            id = "server-item-1",
            author = MessageAuthor.User,
            text = "hello",
            orderSeq = 1,
            updatedSeq = 1,
            clientMessageId = "message-1",
        )

        val merged = mergeOptimisticTimelineMessages(
            realMessages = listOf(serverMessage),
            currentMessages = emptyList(),
            storedMessages = store.read("server-session"),
            orderingItems = emptyList(),
        )

        assertTrue(merged.pending.isEmpty())
        assertEquals(listOf("server-item-1"), merged.messages.map(TimelineMessage::id))
    }

    private fun optimisticMessage(
        id: String,
        orderSeq: Int,
        status: String = "pending",
    ): TimelineMessage = TimelineMessage(
        id = id,
        author = MessageAuthor.User,
        text = "hello",
        status = status,
        orderSeq = orderSeq,
        updatedSeq = orderSeq,
        clientMessageId = id,
        optimistic = true,
    )
}
