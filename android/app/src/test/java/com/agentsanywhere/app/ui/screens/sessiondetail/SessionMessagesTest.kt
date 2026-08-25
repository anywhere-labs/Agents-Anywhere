package com.agentsanywhere.app.ui.screens.sessiondetail

import com.agentsanywhere.app.feature.sessiondetail.MessageAuthor
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessage
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessageKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionMessagesTest {
    @Test
    fun toolRunKeyStaysStableWhenIncrementalMessagesArrive() {
        val first = toolMessage("tool-1")
        val second = toolMessage("tool-2")
        val initial = groupTimelineMessages(listOf(first, second)).single()
        val refreshed = groupTimelineMessages(
            listOf(first.copy(status = "done", updatedSeq = 2), second, toolMessage("tool-3")),
        ).single()

        assertTrue(initial is TimelineRenderItem.ToolRun)
        assertTrue(refreshed is TimelineRenderItem.ToolRun)
        assertEquals("tool-run:tool-1", initial.key)
        assertEquals(initial.key, refreshed.key)
    }

    @Test
    fun toolSummaryTargetIncludesProjectedNameAndTarget() {
        val message = toolMessage("tool").copy(
            title = "Read",
            subtitle = "/workspace/README.md",
        )

        assertEquals("Read /workspace/README.md", message.toolSummaryTarget())
    }

    private fun toolMessage(id: String): TimelineMessage = TimelineMessage(
        id = id,
        author = MessageAuthor.Tool,
        text = id,
        kind = TimelineMessageKind.ToolCall,
        status = "running",
        updatedSeq = 1,
    )
}
