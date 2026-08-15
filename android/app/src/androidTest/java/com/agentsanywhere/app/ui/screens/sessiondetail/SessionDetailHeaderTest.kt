package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionDetailHeaderTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun runtimeSettingsButtonRendersWithoutRefreshState() {
        composeRule.setContent {
            AgentsAnywhereTheme {
                SessionDetailHeader(
                    title = "Session",
                    darkMode = true,
                    onLeftClick = {},
                    onRightClick = {},
                )
            }
        }
    }
}
