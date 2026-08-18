package com.agentsanywhere.app.ui.screens.home

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.SessionListIndicator
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionStatusIndicatorTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun exposesLocalizedApprovalLabelAndStatusDescriptions() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        var indicator by mutableStateOf(SessionListIndicator.WaitingApproval)
        composeRule.setContent {
            AgentsAnywhereTheme {
                SessionStatusIndicator(indicator)
            }
        }

        composeRule
            .onNodeWithText(context.getString(R.string.home_session_status_waiting_approval))
            .assertIsDisplayed()

        mapOf(
            SessionListIndicator.Busy to R.string.home_session_status_running,
            SessionListIndicator.Unread to R.string.home_session_status_unread,
            SessionListIndicator.Error to R.string.home_session_status_error,
        ).forEach { (nextIndicator, descriptionResource) ->
            composeRule.runOnIdle { indicator = nextIndicator }
            composeRule
                .onNodeWithContentDescription(context.getString(descriptionResource))
                .assertIsDisplayed()
        }
    }

    @Test
    fun pinnedRecentAndLongPressRowsAllShowTheSameStatusIndicator() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val label = context.getString(R.string.home_session_status_waiting_approval)
        var rowType by mutableIntStateOf(0)

        composeRule.setContent {
            AgentsAnywhereTheme {
                when (rowType) {
                    0 -> HomePinnedSessionRow(
                        session = session(pinned = true),
                        showDivider = false,
                        onClick = {},
                        onLongPress = {},
                    )
                    1 -> HomeRecentSessionRow(
                        session = session(pinned = false),
                        onClick = {},
                        onLongPress = {},
                    )
                    else -> HomeSessionHighlightRow(session = session(pinned = true), darkMode = false)
                }
            }
        }
        composeRule.onNodeWithText(label).assertIsDisplayed()

        composeRule.runOnIdle { rowType = 1 }
        composeRule.onNodeWithText(label).assertIsDisplayed()

        composeRule.runOnIdle { rowType = 2 }
        composeRule.onNodeWithText(label).assertIsDisplayed()
    }

    private fun session(pinned: Boolean) = AgentSession(
        id = "session",
        connectorId = "connector",
        deviceName = "Device",
        title = "A session title",
        summary = "",
        cwd = "/workspace",
        workspaceLabel = "workspace",
        runtime = "codex",
        runtimeLabel = "Codex",
        status = SessionStatus.WaitingApproval,
        statusLabel = "Approval",
        updatedAtLabel = "now",
        metaLabel = "",
        pinned = pinned,
        archived = false,
        unread = true,
        lastReadSeq = 0,
        takeover = false,
        connectorOnline = true,
        live = true,
        sortKey = "",
        updatedSeq = 1,
    )
}
