package com.agentsanywhere.app.ui.screens.sessiondetail

import com.agentsanywhere.app.feature.sessiondetail.MessageAuthor
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessage
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessageKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionMessagesTest {
    @Test
    fun consecutiveReasoningToolsAndArtifactsShareOneActivityGroup() {
        val messages = listOf(
            message("reasoning", TimelineMessageKind.Reasoning),
            message("tool", TimelineMessageKind.ToolCall),
            message("artifact", TimelineMessageKind.Artifact),
        )

        val groups = groupTimelineMessages(messages)

        assertEquals(1, groups.size)
        assertTrue(groups.single() is TimelineRenderItem.ToolRun)
        assertEquals("tool-run:reasoning", groups.single().key)
        assertEquals(messages, groups.single().messages)
    }

    @Test
    fun normalMessageBreaksActivityGroups() {
        val before = message("before", TimelineMessageKind.ToolCall)
        val reply = message("reply", TimelineMessageKind.Text, MessageAuthor.Agent)
        val after = message("after", TimelineMessageKind.Command)

        val groups = groupTimelineMessages(listOf(before, reply, after))

        assertEquals(3, groups.size)
        assertTrue(groups.all { it is TimelineRenderItem.Single })
        assertEquals(listOf("before", "reply", "after"), groups.map { it.key })
    }

    @Test
    fun activitySummaryMatchesWebCategories() {
        val summary = summarizeTimelineActivities(
            listOf(
                message("reasoning", TimelineMessageKind.Reasoning),
                message("command", TimelineMessageKind.Command),
                message("changed", TimelineMessageKind.FileChange, title = "Edited"),
                message("created", TimelineMessageKind.FileChange, title = "Added"),
                message("tool", TimelineMessageKind.ToolCall),
                message("artifact", TimelineMessageKind.Artifact),
            ),
        )

        assertEquals(
            TimelineActivitySummary(
                reasoning = 1,
                commands = 1,
                changedFiles = 1,
                createdFiles = 1,
                total = 6,
            ),
            summary,
        )
    }

    private fun message(
        id: String,
        kind: TimelineMessageKind,
        author: MessageAuthor = MessageAuthor.Tool,
        title: String = "",
    ): TimelineMessage {
        return TimelineMessage(
            id = id,
            author = author,
            text = id,
            kind = kind,
            title = title,
        )
    }
}
