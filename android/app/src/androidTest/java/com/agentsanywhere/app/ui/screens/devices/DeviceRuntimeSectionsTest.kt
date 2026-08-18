package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeManagementState
import com.agentsanywhere.app.feature.devices.DeviceRuntimeStatus
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeviceRuntimeSectionsTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun configuredAndDiscoveredRuntimesRenderInSeparateSections() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val state = DeviceRuntimeManagementState(
            connectorId = "connector",
            runtimes = listOf(
                runtime("codex", configured = true),
                runtime("claude", configured = false),
            ),
        )

        composeRule.setContent {
            AgentsAnywhereTheme {
                AgentsSection(
                    state = state,
                    deviceOnline = true,
                    onDiscover = {},
                    onRetry = {},
                    onConfigure = {},
                    onSetActive = { _, _ -> },
                    onDeleteConfig = {},
                )
            }
        }

        composeRule.onNodeWithText(context.getString(R.string.device_runtime_configured_section)).assertIsDisplayed()
        composeRule.onNodeWithText(context.getString(R.string.device_runtime_discovered_section)).assertIsDisplayed()
        composeRule.onNodeWithText("codex").assertIsDisplayed()
        composeRule.onNodeWithText("claude").assertIsDisplayed()
        composeRule
            .onAllNodesWithText(context.getString(R.string.configure_agent_action))
            .assertCountEquals(1)
        composeRule
            .onNodeWithContentDescription(context.getString(R.string.configure_agent_description, "claude"))
            .assertIsDisplayed()
    }

    @Test
    fun offlineDeviceDisablesDiscoveryAndConfiguration() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        composeRule.setContent {
            AgentsAnywhereTheme {
                AgentsSection(
                    state = DeviceRuntimeManagementState(
                        connectorId = "connector",
                        runtimes = listOf(runtime("codex", configured = false)),
                    ),
                    deviceOnline = false,
                    onDiscover = {},
                    onRetry = {},
                    onConfigure = {},
                    onSetActive = { _, _ -> },
                    onDeleteConfig = {},
                )
            }
        }

        composeRule
            .onNodeWithContentDescription(context.getString(R.string.device_runtime_discover_description))
            .assertIsNotEnabled()
        composeRule
            .onNodeWithContentDescription(context.getString(R.string.configure_agent_description, "codex"))
            .assertIsNotEnabled()
    }

    private fun runtime(id: String, configured: Boolean): DeviceRuntime {
        return DeviceRuntime(
            connectorId = "connector",
            id = id,
            type = "native",
            displayName = id,
            present = true,
            configured = configured,
            active = false,
            status = if (configured) DeviceRuntimeStatus.Stopped else DeviceRuntimeStatus.Available,
            discovery = mapOf("available" to true),
            schema = null,
            uiSchema = emptyMap(),
            config = null,
            error = null,
            lastDiscoveredAt = null,
            updatedAt = null,
        )
    }
}
