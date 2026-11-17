package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.MISSING_ORDER_SEQ
import com.agentsanywhere.app.api.RemoteTimelineItem
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class TimelineZeroOrderSeqTest {
    private fun item(id: String, role: String, orderSeq: Int) = RemoteTimelineItem(
        id = id,
        sessionId = "session",
        type = "message",
        status = "done",
        role = role,
        text = id,
        content = JSONObject().put("text", id),
        source = JSONObject(),
        orderSeq = orderSeq,
        revision = 1,
        updatedSeq = orderSeq + 10,
        createdAt = "",
        updatedAt = null,
    )

    @Test
    fun zeroBasedFirstItemStaysFirst() {
        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(item("user", "user", 0), item("reply", "assistant", 1), item("final", "assistant", 2)),
            replace = true,
        )
        assertEquals(listOf("user", "reply", "final"), projection.messages.map { it.sourceItemId })
        assertEquals(0, projection.orderingItems.single { it.id == "user" }.orderSeq)
    }

    @Test
    fun zeroOrderSeqSurvivesIncrementalMerge() {
        val initial = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(item("reply", "assistant", 1)),
            replace = true,
        )
        val merged = mergeRemoteTimelineItems(
            currentOrdering = initial.orderingItems,
            currentMessages = initial.messages,
            incoming = listOf(item("user", "user", 0)),
            replace = false,
        )
        assertEquals(listOf("user", "reply"), merged.messages.map { it.sourceItemId })
    }

    @Test
    fun missingOrderSeqIsAppendedAfterKnownItems() {
        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(item("late", "assistant", MISSING_ORDER_SEQ), item("user", "user", 0), item("reply", "assistant", 1)),
            replace = true,
        )
        assertEquals(listOf("user", "reply", "late"), projection.messages.map { it.sourceItemId })
    }
}
