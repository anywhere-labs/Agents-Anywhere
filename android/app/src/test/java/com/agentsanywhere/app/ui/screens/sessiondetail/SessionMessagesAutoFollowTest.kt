package com.agentsanywhere.app.ui.screens.sessiondetail

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionMessagesAutoFollowTest {
    @Test
    fun readingOnlyResumesFollowingAfterExplicitReturn() {
        val state = TimelineReadingState()
        assertTrue(state.following)
        state.gesture(24f)
        assertFalse(state.following)
        state.invalidate()
        assertFalse(state.following)
        state.release()
        assertTrue(state.following)
    }

    @Test
    fun expansionSurvivesGroupAppendSplitAndMerge() {
        val state = TimelineReadingState()
        state.toggle("first", "header:first")
        assertTrue(state.groupExpanded("tools", listOf("first", "second")))
        state.toggleGroup("tools", listOf("first", "second"), "group")
        assertFalse(state.groupExpanded("tools", listOf("first", "second", "third")))
        state.toggleGroup("tools", listOf("first", "second", "third"), "group")
        assertTrue(state.groupExpanded("tools", listOf("second", "third")))
        assertTrue(state.groupExpanded("tools", listOf("older", "first", "second", "third")))
        assertFalse(state.groupExpanded("reconnect", listOf("other")))
    }
}
