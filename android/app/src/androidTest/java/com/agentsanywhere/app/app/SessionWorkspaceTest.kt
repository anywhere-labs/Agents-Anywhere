package com.agentsanywhere.app.app

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionWorkspaceTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun actualParentConstraintsChooseSinglePaneAndBoundedSidebar() {
        var width by mutableStateOf(599.dp)
        var showDetail by mutableStateOf(false)
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f)) {
                AgentsAnywhereTheme {
                    SessionWorkspace(
                        showDetail = showDetail,
                        detailKey = "session:A",
                        stateHolder = rememberSaveableStateHolder(),
                        sidebarCollapsed = false,
                        onSidebarCollapsedChange = {},
                        modifier = Modifier.requiredWidth(width).height(500.dp),
                        home = { _, _ -> Box(Modifier.fillMaxSize().testTag("home")) },
                        detail = { Box(Modifier.fillMaxSize().testTag("detail")) },
                    )
                }
            }
        }
        compose.onNodeWithTag("home").assertWidthIsEqualTo(599.dp)
        compose.onNodeWithTag("detail").assertDoesNotExist()
        compose.runOnIdle { showDetail = true }
        compose.onNodeWithTag("home").assertDoesNotExist()
        compose.onNodeWithTag("detail").assertWidthIsEqualTo(599.dp)

        for ((available, sidebar) in listOf(600 to 240, 800 to 288, 1000 to 320)) {
            compose.runOnIdle { width = available.dp }
            compose.onNodeWithTag("home").assertWidthIsEqualTo(sidebar.dp)
            compose.onNodeWithTag("detail").assertWidthIsEqualTo((available - sidebar).dp)
        }
    }

    @Test
    fun collapseRestoresAndNeverHidesNarrowListOrLosesAccessibleReopen() {
        val restoration = StateRestorationTester(compose)
        var width by mutableStateOf(800.dp)
        var expandDescription = ""
        restoration.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f)) {
                AgentsAnywhereTheme {
                    var collapsed by rememberSaveable { mutableStateOf(false) }
                    expandDescription = androidx.compose.ui.res.stringResource(R.string.workspace_expand_sidebar)
                    SessionWorkspace(
                        showDetail = false,
                        detailKey = null,
                        stateHolder = rememberSaveableStateHolder(),
                        sidebarCollapsed = collapsed,
                        onSidebarCollapsedChange = { collapsed = it },
                        modifier = Modifier.requiredWidth(width).height(500.dp),
                        home = { _, collapse -> Button(onClick = { collapse?.invoke() }) { Text("collapse") } },
                        detail = { Text("unexpected detail") },
                    )
                }
            }
        }
        compose.onNodeWithText("collapse").performClick()
        compose.onNodeWithContentDescription(expandDescription)
            .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("collapse").assertDoesNotExist()
        compose.onNodeWithContentDescription(expandDescription).assertExists()

        compose.runOnIdle { width = 599.dp }
        compose.onNodeWithText("collapse").assertExists()
        compose.onNodeWithContentDescription(expandDescription).assertDoesNotExist()
        compose.runOnIdle { width = 800.dp }
        compose.onNodeWithText("collapse").assertDoesNotExist()
        compose.onNodeWithContentDescription(expandDescription).performClick()
        compose.onNodeWithText("collapse").assertExists()
        compose.onNodeWithText("unexpected detail").assertDoesNotExist()
    }

    @Test
    fun sessionIdentityRestoresWithOneDetailAcrossResizeAndCollapseAndResetsForAccount() {
        val restoration = StateRestorationTester(compose)
        var width by mutableStateOf(800.dp)
        var requestedSession by mutableStateOf("A")
        var account by mutableStateOf("first")
        var activeDetails = 0
        var maximumDetails = 0
        var mounts = 0
        var expandDescription = ""
        restoration.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f)) {
                AgentsAnywhereTheme {
                    key("https://example.invalid", account) {
                        val holder = rememberSaveableStateHolder()
                        var collapsed by rememberSaveable { mutableStateOf(false) }
                        expandDescription = androidx.compose.ui.res.stringResource(R.string.workspace_expand_sidebar)
                        SessionWorkspace(
                            showDetail = true,
                            detailKey = "session:$requestedSession",
                            stateHolder = holder,
                            sidebarCollapsed = collapsed,
                            onSidebarCollapsedChange = { collapsed = it },
                            modifier = Modifier.requiredWidth(width).height(500.dp),
                            home = { _, collapse -> Button(onClick = { collapse?.invoke() }) { Text("collapse") } },
                            detail = {
                                val identity = requestedSession
                                DisposableEffect(identity) {
                                    activeDetails++
                                    mounts++
                                    maximumDetails = maxOf(maximumDetails, activeDetails)
                                    onDispose { activeDetails-- }
                                }
                                var count by rememberSaveable { mutableStateOf(0) }
                                Button(onClick = { count++ }, modifier = Modifier.testTag("detail")) {
                                    Text("$identity:$count")
                                }
                            },
                        )
                    }
                }
            }
        }
        compose.onNodeWithText("A:0").performClick()
        compose.runOnIdle { requestedSession = "B" }
        compose.onNodeWithText("B:0").performClick()
        compose.onNodeWithText("B:1").performClick()
        compose.runOnIdle { requestedSession = "A" }
        compose.onNodeWithText("A:1").assertExists()
        val mountsBeforeResize = compose.runOnIdle { mounts }
        compose.onNodeWithText("collapse").performClick()
        compose.runOnIdle { width = 599.dp }
        compose.runOnIdle { width = 1000.dp }
        compose.onNodeWithContentDescription(expandDescription).performClick()
        compose.runOnIdle { assertEquals(mountsBeforeResize, mounts) }
        compose.onNodeWithText("A:1").assertExists()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("A:1").assertExists()
        compose.runOnIdle { requestedSession = "B" }
        compose.onNodeWithText("B:2").assertExists()
        compose.onAllNodesWithTag("detail").assertCountEquals(1)
        compose.runOnIdle {
            assertEquals(1, maximumDetails)
            account = "second"
        }
        compose.onNodeWithText("B:0").assertExists()
    }
}
