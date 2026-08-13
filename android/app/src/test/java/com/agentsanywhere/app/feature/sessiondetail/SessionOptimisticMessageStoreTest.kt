package com.agentsanywhere.app.feature.sessiondetail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.concurrent.thread

class SessionOptimisticMessageStoreTest {
    @Test
    fun messagesAreIsolatedBySessionAndReplaceDropsConfirmedRows() {
        val store = SessionOptimisticMessageStore()
        val first = optimistic("first", 2)
        val replacement = optimistic("first", 3).copy(text = "retry")
        store.upsert("a", first)
        store.upsert("b", optimistic("second", 1))
        store.upsert("a", replacement)

        assertEquals(listOf("retry"), store.read("a").map { it.text })
        assertEquals(listOf("second"), store.read("b").map { it.id })

        store.replace("a", listOf(replacement.copy(optimistic = false)))
        assertTrue(store.read("a").isEmpty())
        assertEquals(1, store.read("b").size)
    }

    @Test
    fun concurrentSessionsDoNotShareMutableState() {
        val store = SessionOptimisticMessageStore()
        val workers = (0 until 20).map { index ->
            thread {
                val sessionId = "session-${index % 2}"
                store.upsert(sessionId, optimistic("message-$index", index + 1))
            }
        }
        workers.forEach(Thread::join)

        assertEquals(10, store.read("session-0").size)
        assertEquals(10, store.read("session-1").size)
        assertTrue(store.read("session-0").none { it in store.read("session-1") })
    }

    private fun optimistic(id: String, order: Int) = TimelineMessage(
        id = id,
        author = MessageAuthor.User,
        text = id,
        orderSeq = order,
        updatedSeq = order,
        clientMessageId = id,
        optimistic = true,
    )
}
