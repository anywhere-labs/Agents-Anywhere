package com.agentsanywhere.app.ui.screens.home

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceAgentPreviews
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HomeSidebarTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun flatPinnedAndRecentEntriesUseExistingOpenCallbackAndSelectedSemantics() {
        val sessions = listOf(session("Pinned entry", pinned = true), session("Recent entry"))
        val opened = mutableListOf<String>()
        compose.setContent {
            var selected by remember { mutableStateOf<String?>(null) }
            home(sessions, HomeSidebarViewMode.Session, selected, onOpen = {
                opened += it.id
                selected = it.id
            })
        }

        clickSession("Pinned entry")
        sessionNode("Pinned entry").assertIsSelected()
        clickSession("Recent entry")
        sessionNode("Recent entry").assertIsSelected()
        sessionNode("Pinned entry").assertIsNotSelected()
        assertEquals(listOf("Pinned entry", "Recent entry"), opened)
    }

    @Test
    fun projectPinnedSessionAndBothProjectChildPathsPropagateSelection() {
        val projects = listOf(project("Pinned project", pinned = true), project("Regular project"))
        val sessions = listOf(
            session("Pinned session", pinned = true),
            session("Pinned project child", projectId = projects[0].id),
            session("Regular project child", projectId = projects[1].id),
        )
        seedExpandedProjects(projects)
        val opened = mutableListOf<String>()
        compose.setContent {
            var selected by remember { mutableStateOf<String?>(null) }
            home(sessions, HomeSidebarViewMode.Project, selected, projects, onOpen = {
                opened += it.id
                selected = it.id
            })
        }

        sessions.forEach {
            clickSession(it.title)
            sessionNode(it.title).assertIsSelected()
        }
        assertEquals(sessions.map { it.id }, opened)
    }

    @Test
    fun sectionStateSurvivesModeRoundTripAndRestoration() {
        val mode = mutableStateOf(HomeSidebarViewMode.Session)
        val restoration = StateRestorationTester(compose)
        restoration.setContent {
            home(listOf(session("Pinned entry", pinned = true), session("Recent entry")), mode.value, null)
        }
        compose.onNodeWithText(compose.activity.getString(R.string.home_pinned)).performClick()
        sessionNode("Pinned entry").assertDoesNotExist()
        compose.runOnIdle { mode.value = HomeSidebarViewMode.Project }
        compose.runOnIdle { mode.value = HomeSidebarViewMode.Session }
        sessionNode("Pinned entry").assertDoesNotExist()
        restoration.emulateSavedInstanceStateRestore()
        sessionNode("Pinned entry").assertDoesNotExist()
        sessionNode("Recent entry").assertIsDisplayed()
    }

    @Test
    fun listScrollSurvivesModeRoundTripAndRestoration() {
        val sessions = List(40) { session("Scroll entry$it") }
        val mode = mutableStateOf(HomeSidebarViewMode.Session)
        val restoration = StateRestorationTester(compose)
        restoration.setContent { home(sessions, mode.value, null) }

        val target = "Scroll entry20"
        val list = compose.onNode(hasScrollAction())
        list.performScrollToNode(hasText(target) and hasClickAction())
        list.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 37f) }
        val savedScroll = list.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
        val savedRowTop = sessionNode(target).assertIsDisplayed().fetchSemanticsNode().boundsInRoot.top -
            list.fetchSemanticsNode().boundsInRoot.top
        assertTrue("The real Home list must be scrolled before saving", savedScroll > 0f)

        fun assertSavedPosition() {
            val currentScroll = list.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
            val rowTop = sessionNode(target).assertIsDisplayed().fetchSemanticsNode().boundsInRoot.top -
                list.fetchSemanticsNode().boundsInRoot.top
            assertEquals("Home list scroll must restore", savedScroll, currentScroll, 1f)
            assertEquals("The same session must retain its viewport offset", savedRowTop, rowTop, 1f)
        }

        compose.runOnIdle { mode.value = HomeSidebarViewMode.Project }
        compose.runOnIdle { mode.value = HomeSidebarViewMode.Session }
        assertSavedPosition()
        restoration.emulateSavedInstanceStateRestore()
        assertSavedPosition()
    }

    @Test
    fun compactQuickEntriesRemainClickableAt240dp() {
        val navigated = mutableListOf<AppDestination>()
        compose.setContent {
            home(listOf(session("Recent entry")), HomeSidebarViewMode.Session, null, navigate = navigated::add)
        }
        listOf(R.string.devices_title, R.string.common_terminal, R.string.common_files).forEach {
            compose.onNode(hasText(compose.activity.getString(it)) and hasClickAction())
                .assertIsDisplayed().performClick()
        }
        assertEquals(listOf(AppDestination.Devices, AppDestination.Terminal, AppDestination.Files), navigated)
    }

    @Test
    fun bothActionMenusFitNarrowOffsetParent() {
        val projectMenu = mutableStateOf(false)
        val width = mutableStateOf(240)
        compose.setContent {
            AgentsAnywhereTheme {
                Box(Modifier.padding(start = 30.dp, top = 40.dp)) {
                    Box(Modifier.width(width.value.dp).fillMaxHeight().testTag("overlay-parent")) {
                        val density = LocalDensity.current
                        val row = with(density) { Rect(40.dp.toPx(), 90.dp.toPx(), 230.dp.toPx(), 134.dp.toPx()) }
                        if (projectMenu.value) {
                            HomeProjectActionOverlay(
                                menu = HomeProjectActionMenu(project("Project"), row),
                                onDismiss = {}, onEdit = {}, onTogglePinned = {}, onArchive = {},
                            )
                        } else {
                            HomeSessionActionOverlay(
                                menu = HomeSessionActionMenu(session("Session"), row, projectView = true),
                                onDismiss = {}, onRename = {}, onTogglePinned = {}, onToggleArchived = {},
                            )
                        }
                    }
                }
            }
        }
        listOf(240, 320).forEach { size ->
            listOf(false, true).forEach { isProject ->
                compose.runOnIdle { width.value = size; projectMenu.value = isProject }
                val label = compose.activity.getString(if (isProject) R.string.home_project_edit else R.string.home_rename)
                val parent = compose.onNodeWithTag("overlay-parent").fetchSemanticsNode()
                val action = compose.onNode(hasText(label) and hasClickAction()).assertIsDisplayed()
                    .fetchSemanticsNode()
                // Native Popup has a separate window, so use common screen coordinates.
                val parentLeft = parent.positionOnScreen.x
                val actionLeft = action.positionOnScreen.x
                assertTrue("menu left must use overlay-local coordinates", actionLeft >= parentLeft)
                assertTrue("menu must fit sidebar width", actionLeft + action.size.width <= parentLeft + parent.size.width)
                compose.onAllNodes(hasText("Session") and hasClickAction()).assertCountEquals(0)
            }
        }
    }

    private fun sessionNode(title: String) = compose.onNode(hasText(title) and hasClickAction())

    private fun clickSession(title: String) {
        compose.onNode(hasScrollAction()).performScrollToNode(hasText(title) and hasClickAction())
        sessionNode(title).performClick()
    }

    private fun seedExpandedProjects(projects: List<AgentProject>) {
        val key = JSONArray(listOf(SERVER, USER)).toString()
        compose.activity.getSharedPreferences("project_sidebar", 0).edit().clear()
            .putStringSet("$key:ids", projects.map { it.id }.toSet()).commit()
    }

    @Composable
    private fun home(
        sessions: List<AgentSession>,
        mode: String,
        selected: String?,
        projects: List<AgentProject> = emptyList(),
        navigate: (AppDestination) -> Unit = {},
        onOpen: (AgentSession) -> Unit = {},
    ) {
        AgentsAnywhereTheme {
            Box(Modifier.width(240.dp).fillMaxHeight()) {
                HomeScreen(
                    navigate = navigate,
                    state = SessionsState(sessions = sessions, projects = projects, devices = listOf(AgentDevice("device", "Device", online = true)), hasLoaded = true),
                    selectedTab = HomeTab.Active,
                    isRefreshing = false,
                    userId = USER,
                    serverUrl = SERVER,
                    sidebarViewMode = mode,
                    projectSessionsById = sessions.filter { it.projectId != null }.groupBy { it.projectId!! },
                    loadingProjectRequests = emptySet(), projectSessionErrors = emptyMap(),
                    onRefresh = {}, onLoadMore = {}, onTabSelected = {},
                    profileOpen = false, onProfileOpenChange = {},
                    onRenameSession = { _, _ -> Result.failure(UnsupportedOperationException()) },
                    onSetSessionPinned = { _, _ -> Result.failure(UnsupportedOperationException()) },
                    onSetSessionArchived = { _, _ -> Result.failure(UnsupportedOperationException()) },
                    onLoadProjects = { Result.success(projects) }, onLoadProjectSessions = { _, _ -> },
                    onUpdateProject = { _, _, _ -> Result.failure(UnsupportedOperationException()) },
                    onArchiveProjectSessions = { Result.success(emptyList()) },
                    onNewSessionInProject = {}, onOpenSession = onOpen, onOpenDevice = {},
                    deviceAgentPreviews = DeviceAgentPreviews(), onPairDevice = {},
                    selectedSessionId = selected, compact = true, onCollapseSidebar = {},
                )
            }
        }
    }

    private fun session(title: String, pinned: Boolean = false, projectId: String? = null) = AgentSession(
        id = title, connectorId = "device", projectId = projectId, deviceName = "Device", title = title,
        summary = "", cwd = "/workspace", workspaceLabel = "workspace", runtime = "codex", runtimeLabel = "Codex",
        status = SessionStatus.WaitingApproval, statusLabel = "Approval", updatedAtLabel = "now", metaLabel = "",
        pinned = pinned, archived = false, unread = false, lastReadSeq = 0, takeover = false,
        connectorOnline = true, live = false, sortKey = "", updatedSeq = 0,
    )

    private fun project(name: String, pinned: Boolean = false) = AgentProject(
        id = name, userId = USER, connectorId = "device", name = name, workspacePath = "/workspace/$name",
        pinned = pinned, pinnedAt = null, activeSessionCount = 1, lastActivityAt = null, createdAt = "", updatedAt = "",
    )

    private companion object {
        const val USER = "home-sidebar-test"
        const val SERVER = "https://home-sidebar-test.invalid"
    }
}
