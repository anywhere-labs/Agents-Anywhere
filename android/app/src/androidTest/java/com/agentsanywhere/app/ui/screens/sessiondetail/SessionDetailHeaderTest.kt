package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionDetailHeaderTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun refreshButtonChangesDescriptionAndDisablesWhileRefreshing() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        var refreshing by mutableStateOf(false)
        var clickCount = 0
        composeRule.setContent {
            AgentsAnywhereTheme {
                SessionDetailHeader(
                    title = "Session",
                    darkMode = true,
                    refreshing = refreshing,
                    onLeftClick = {
                        clickCount += 1
                        refreshing = true
                    },
                    onRightClick = {},
                )
            }
        }

        composeRule
            .onNodeWithContentDescription(context.getString(R.string.session_refresh_action))
            .assertIsEnabled()
            .performClick()

        composeRule
            .onNodeWithContentDescription(context.getString(R.string.session_refreshing_action))
            .assertIsNotEnabled()
        assertEquals(1, clickCount)
    }
}
