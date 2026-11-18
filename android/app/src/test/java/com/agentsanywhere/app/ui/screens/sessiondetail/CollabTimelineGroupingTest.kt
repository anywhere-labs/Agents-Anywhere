package com.agentsanywhere.app.ui.screens.sessiondetail

import com.agentsanywhere.app.feature.sessiondetail.CollabTool
import com.agentsanywhere.app.feature.sessiondetail.MessageAuthor
import com.agentsanywhere.app.feature.sessiondetail.TimelineCollabTool
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessage
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessageKind
import org.junit.Assert.assertEquals
import org.junit.Test

class CollabTimelineGroupingTest {
    private fun tool(id: String, collab: Boolean = false) = TimelineMessage(
        id = id,
        author = MessageAuthor.Tool,
        text = id,
        type = "tool",
        kind = TimelineMessageKind.ToolCall,
        collabTool = if (collab) TimelineCollabTool(CollabTool.Send, "aa_send", "sess_child") else null,
    )

    @Test
    fun collaborationToolCallsStayOutOfToolRuns() {
        val items = groupTimelineMessages(listOf(tool("a"), tool("b"), tool("c", collab = true), tool("d"), tool("e")))
        assertEquals(
            listOf(listOf("a", "b"), listOf("c"), listOf("d", "e")),
            items.map { item -> item.messages.map { it.id } },
        )
        assertEquals(TimelineRenderItem.Single::class, items[1]::class)
    }
}
