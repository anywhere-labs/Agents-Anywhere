package com.agentsanywhere.app.ui.screens.devices

import android.os.LocaleList
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceAgentPreviewState
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeviceAgentPreviewTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun deviceRowsShowLoadedAndZeroOnlineAgentCounts() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val twoAgents = context.resources.getQuantityString(R.plurals.devices_agents_online, 2, 2)
        val zeroAgents = context.resources.getQuantityString(R.plurals.devices_agents_online, 0, 0)

        composeRule.setContent {
            AgentsAnywhereTheme {
                Column {
                    DeviceRow(
                        device = device("two"),
                        agentPreview = DeviceAgentPreviewState.Loaded(2),
                        darkMode = false,
                        onClick = {},
                    )
                    DeviceRow(
                        device = device("zero"),
                        agentPreview = DeviceAgentPreviewState.Loaded(0),
                        darkMode = false,
                        onClick = {},
                    )
                }
            }
        }

        composeRule.onNodeWithText(twoAgents).assertIsDisplayed()
        composeRule.onNodeWithText(zeroAgents).assertIsDisplayed()
    }

    @Test
    fun deviceRowsShowLoadingUnavailableAndOfflineStates() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        composeRule.setContent {
            AgentsAnywhereTheme {
                Column {
                    DeviceRow(
                        device = device("loading"),
                        agentPreview = DeviceAgentPreviewState.Loading,
                        darkMode = false,
                        onClick = {},
                    )
                    DeviceRow(
                        device = device("unavailable"),
                        agentPreview = DeviceAgentPreviewState.Unavailable,
                        darkMode = false,
                        onClick = {},
                    )
                    DeviceRow(
                        device = device("offline", online = false),
                        agentPreview = DeviceAgentPreviewState.Loaded(5),
                        darkMode = false,
                        onClick = {},
                    )
                }
            }
        }

        composeRule
            .onNodeWithText(context.getString(R.string.devices_agent_status_loading))
            .assertIsDisplayed()
        composeRule
            .onNodeWithText(context.getString(R.string.devices_agent_status_unavailable))
            .assertIsDisplayed()
        composeRule
            .onAllNodesWithText(context.getString(R.string.devices_offline), useUnmergedTree = true)
            .assertCountEquals(2)
    }

    @Test
    fun onlineAgentQuantityResourcesAreLocalized() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val englishConfiguration = android.content.res.Configuration(context.resources.configuration).apply {
            setLocales(LocaleList(Locale.US))
        }
        val chineseConfiguration = android.content.res.Configuration(context.resources.configuration).apply {
            setLocales(LocaleList(Locale.SIMPLIFIED_CHINESE))
        }
        val english = context.createConfigurationContext(englishConfiguration).resources
        val chinese = context.createConfigurationContext(chineseConfiguration).resources

        assertEquals("1 agent online", english.getQuantityString(R.plurals.devices_agents_online, 1, 1))
        assertEquals("2 agents online", english.getQuantityString(R.plurals.devices_agents_online, 2, 2))
        assertEquals("2 个 Agent 在线", chinese.getQuantityString(R.plurals.devices_agents_online, 2, 2))
    }

    private fun device(
        id: String,
        online: Boolean = true,
    ): AgentDevice {
        return AgentDevice(
            id = id,
            name = id,
            online = online,
        )
    }
}
