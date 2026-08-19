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

    @Test
    fun dshFinalAssistantMessageReplacesLiveActivityImmediately() {
        val activity = item("activity", orderSeq = 2, updatedSeq = 2).copy(
            revision = 3,
            contentHash = "sha256:same-reply",
            source = JSONObject()
                .put("runtime", "dsh")
                .put("itemType", "assistant_activity"),
        )
        val final = item("final", orderSeq = 3, updatedSeq = 3).copy(
            contentHash = "sha256:same-reply",
            source = JSONObject()
                .put("runtime", "dsh")
                .put("itemType", "message"),
        )

        val live = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(activity),
            replace = false,
        )
        val completed = mergeRemoteTimelineItems(
            currentOrdering = live.orderingItems,
            currentMessages = live.messages,
            incoming = listOf(final),
            replace = false,
        )

        assertEquals(listOf("final"), completed.messages.map { it.id })
    }

    @Test
    fun identicalDshRepliesAcrossUserTurnRemainDistinct() {
        val first = item("first", orderSeq = 1, updatedSeq = 1).copy(
            contentHash = "sha256:same-reply",
            source = JSONObject().put("runtime", "dsh").put("itemType", "message"),
        )
        val user = item("user", orderSeq = 2, updatedSeq = 2).copy(role = "user")
        val second = item("second", orderSeq = 3, updatedSeq = 3).copy(
            contentHash = "sha256:same-reply",
            source = JSONObject().put("runtime", "dsh").put("itemType", "message"),
        )

        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(first, user, second),
            replace = true,
        )

        assertEquals(listOf("first", "user", "second"), projection.messages.map { it.id })
    }

    @Test
    fun blankAssistantMessageKeepsOrderingWithoutRenderingDiagnosticRow() {
        val blank = item("blank", orderSeq = 1, updatedSeq = 1).copy(
            text = "",
            content = JSONObject().put("kind", "markdown").put("text", ""),
            source = JSONObject().put("runtime", "dsh").put("itemType", "assistant_activity"),
        )

        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(blank),
            replace = true,
        )

        assertEquals(listOf("blank"), projection.orderingItems.map { it.id })
        assertEquals(emptyList<TimelineMessage>(), projection.messages)
    }

    @Test
    fun markdownAssistantMessageRendersNormally() {
        val markdown = item("markdown", orderSeq = 1, updatedSeq = 1).copy(
            text = "",
            content = JSONObject().put("kind", "markdown").put("text", "**hello**"),
        )

        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(markdown),
            replace = true,
        )

        assertEquals(TimelineMessageKind.Text, projection.messages.single().kind)
        assertEquals("**hello**", projection.messages.single().text)
    }

    @Test
    fun messageWithTextRendersEvenWhenContentKindIsNew() {
        val message = item("future-message", orderSeq = 1, updatedSeq = 1).copy(
            text = "",
            content = JSONObject().put("kind", "future_markdown").put("text", "hello"),
        )

        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(message),
            replace = true,
        )

        assertEquals(1, projection.messages.size)
        assertEquals(TimelineMessageKind.Text, projection.messages.single().kind)
        assertEquals("hello", projection.messages.single().text)
    }

    @Test
    fun dshToolTitleUsesProjectedTitleBeforeProtocolKind() {
        val tool = item("tool", orderSeq = 1, updatedSeq = 1).copy(
            type = "tool",
            text = "",
            content = JSONObject()
                .put("kind", "tool_call")
                .put("title", "bash")
                .put("input", JSONObject().put("command", "pwd && ls -la")),
        )

        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(tool),
            replace = true,
        )

        assertEquals("bash", projection.messages.single().title)
        assertEquals("pwd && ls -la", projection.messages.single().subtitle)
        assertEquals(TimelineMessageKind.ToolCall, projection.messages.single().kind)
    }

    @Test
    fun toolResultKeepsCompactWebCompatibleFallbackTitle() {
        val result = item("tool-result", orderSeq = 1, updatedSeq = 1).copy(
            type = "tool",
            role = "tool",
            text = "",
            content = JSONObject().put("kind", "tool_result").put("output", "ok"),
        )

        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(result),
            replace = true,
        )

        assertEquals("tool_result", projection.messages.single().title)
        assertEquals("ok", projection.messages.single().body)
    }

    @Test
    fun diffArtifactIsRetainedForOrderingButNotRendered() {
        val diff = item("diff", orderSeq = 1, updatedSeq = 1).copy(
            type = "artifact",
            text = "",
            content = JSONObject().put("kind", "diff").put("text", "@@ -1 +1 @@"),
        )

        val projection = mergeRemoteTimelineItems(
            currentOrdering = emptyList(),
            currentMessages = emptyList(),
            incoming = listOf(diff),
            replace = true,
        )

        assertEquals(listOf("diff"), projection.orderingItems.map { it.id })
        assertEquals(emptyList<TimelineMessage>(), projection.messages)
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
