package com.agentsanywhere.app.ui.screens.sessiondetail

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionMessagesAutoFollowTest {
    @Test
    fun followsRealtimeUpdatesOnlyWhenAlreadyAtLatest() {
        assertFalse(
            shouldAutoFollowRealtime(
                hasRealtimeUpdate = true,
                autoFollowLatest = true,
                userPaused = false,
                scrolling = false,
                atLatest = false,
            ),
        )
        assertTrue(
            shouldAutoFollowRealtime(
                hasRealtimeUpdate = true,
                autoFollowLatest = true,
                userPaused = false,
                scrolling = false,
                atLatest = true,
            ),
        )
    }

    @Test
    fun realtimeFollowKeepsExistingPauseConditions() {
        assertFalse(
            shouldAutoFollowRealtime(
                hasRealtimeUpdate = false,
                autoFollowLatest = true,
                userPaused = false,
                scrolling = false,
                atLatest = true,
            ),
        )
        assertFalse(
            shouldAutoFollowRealtime(
                hasRealtimeUpdate = true,
                autoFollowLatest = false,
                userPaused = false,
                scrolling = false,
                atLatest = true,
            ),
        )
        assertFalse(
            shouldAutoFollowRealtime(
                hasRealtimeUpdate = true,
                autoFollowLatest = true,
                userPaused = true,
                scrolling = false,
                atLatest = true,
            ),
        )
        assertFalse(
            shouldAutoFollowRealtime(
                hasRealtimeUpdate = true,
                autoFollowLatest = true,
                userPaused = false,
                scrolling = true,
                atLatest = true,
            ),
        )
    }
}
