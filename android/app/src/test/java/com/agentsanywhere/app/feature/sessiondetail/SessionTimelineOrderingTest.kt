package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteTimelineItem
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionTimelineOrderingTest {
    private fun item(
        id: String,
        orderSeq: Int,
        role: String,
        revision: Int = 1,
        updatedSeq: Int = orderSeq,
    ) = RemoteTimelineItem(
        id = id,
        sessionId = "sess1",
        type = "message",
        status = "done",
        role = role,
        text = "text-$id",
        content = JSONObject(),
        source = JSONObject(),
        orderSeq = orderSeq,
        revision = revision,
        updatedSeq = updatedSeq,
        createdAt = "2026-10-08T00:00:00Z",
        updatedAt = null,
    )

    @Test
    fun replaceKeepsServerZeroOrderSeqInsteadOfDeferringToBottom() {
        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(
                item("user", 0, "user"),
                item("system", 1, "user"),
                item("reply", 2, "assistant"),
            ),
            replace = true,
        )
        assertEquals(listOf("user", "system", "reply"), projection.messages.map { it.sourceItemId })
        assertEquals(listOf(0, 1, 2), projection.orderingItems.map { it.orderSeq })
    }

    @Test
    fun replaceTrustedServerRenumberingOverStaleLocalOrdering() {
        val projection = mergeRemoteTimelineItems(
            currentOrdering = listOf(
                TimelineOrderingItem("user", 1, 1, 1),
                TimelineOrderingItem("system", 2, 1, 2),
                TimelineOrderingItem("reply", 3, 1, 3),
            ),
            currentMessages = emptyList(),
            incoming = listOf(
                item("user", 0, "user"),
                item("system", 1, "user"),
                item("reply", 2, "assistant"),
            ),
            replace = true,
        )
        assertEquals(listOf(0, 1, 2), projection.orderingItems.map { it.orderSeq })
        assertEquals(listOf("user", "system", "reply"), projection.messages.map { it.sourceItemId })
    }

    @Test
    fun incrementalZeroOrderSeqKeepsServerValueInsteadOfAppending() {
        val projection = mergeRemoteTimelineItems(
            currentOrdering = listOf(
                TimelineOrderingItem("system", 1, 1, 1),
                TimelineOrderingItem("reply", 2, 1, 2),
            ),
            currentMessages = emptyList(),
            incoming = listOf(item("user", 0, "user")),
            replace = false,
        )
        assertEquals(0, projection.orderingItems.first { it.id == "user" }.orderSeq)
        assertEquals(1, projection.orderingItems.first { it.id == "system" }.orderSeq)
        assertEquals(listOf("user"), projection.messages.map { it.sourceItemId })
    }

    @Test
    fun incrementalZeroFallsBackToExistingPositiveOrder() {
        val projection = mergeRemoteTimelineItems(
            currentOrdering = listOf(TimelineOrderingItem("user", 5, 1, 5)),
            currentMessages = emptyList(),
            incoming = listOf(item("user", 0, "user", revision = 2, updatedSeq = 6)),
            replace = false,
        )
        assertEquals(5, projection.orderingItems.first { it.id == "user" }.orderSeq)
    }

    @Test
    fun mergeOrderingKeepsZeroInsteadOfJumpingToMaxPlusOne() {
        val merged = mergeTimelineOrderingItems(
            current = listOf(TimelineOrderingItem("system", 1, 1, 1)),
            incoming = listOf(TimelineOrderingItem("user", 0, 1, 1)),
        )
        assertEquals(0, merged.first { it.id == "user" }.orderSeq)
        assertEquals(1, merged.first { it.id == "system" }.orderSeq)
    }
}
