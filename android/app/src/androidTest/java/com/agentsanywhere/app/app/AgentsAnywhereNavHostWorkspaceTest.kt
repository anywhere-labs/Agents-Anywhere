package com.agentsanywhere.app.app

import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.espresso.Espresso
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.api.AuthMeResponse
import com.agentsanywhere.app.api.FilesApi
import com.agentsanywhere.app.api.RealtimeApi
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.TerminalApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.auth.WebLoginViewModel
import com.agentsanywhere.app.feature.files.FilesController
import com.agentsanywhere.app.feature.realtime.SessionRealtimeController
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessions.NewSessionCreateOutcome
import com.agentsanywhere.app.feature.sessions.NewSessionDraft
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.terminal.RemoteTerminalPool
import com.agentsanywhere.app.feature.terminal.TerminalController
import com.agentsanywhere.app.feature.update.AppUpdateViewModel
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import com.agentsanywhere.app.ui.screens.home.HomeTab
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real assembly smoke tests; no network authentication, so remote loading fails locally. */
@RunWith(AndroidJUnit4::class)
class AgentsAnywhereNavHostWorkspaceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val draft = NewSessionDraft(
        connectorId = "device", runtime = "codex", title = "Work session", cwd = "/workspace",
        deviceName = "Device", runtimeLabel = "Codex", knownSessionIds = emptySet(),
    )
    private val session = draft.previewSession().copy(id = "workspace-session", projectId = "workspace-project")
    private val project = AgentProject(
        id = "workspace-project", userId = "workspace-nav-test", connectorId = "device", name = "Project P",
        workspacePath = "/workspace/P", pinned = false, pinnedAt = null, activeSessionCount = 1,
        lastActivityAt = null, createdAt = "", updatedAt = "",
    )
    private var sidebarMode by mutableStateOf("session")
    private var destination by mutableStateOf(AppDestination.Sessions)
    private var selected by mutableStateOf<String?>(null)
    private var prepared by mutableStateOf<NewSessionDraft?>(null)
    private var opened = 0

    @Test
    fun selectingRealListRowKeepsSidebarAndReturningToSessionsClearsDetailAndHighlight() {
        showNavHost()
        selectSession()
        compose.onAllNodesWithText(session.title).assertCountEquals(2)
        sessionRow().assertIsSelected()
        pressBack()
        compose.onNodeWithText(text(R.string.session_open_from_list)).assertIsDisplayed()
        compose.onAllNodesWithText(session.title).assertCountEquals(1)
        sessionRow().assertIsNotSelected()
        compose.runOnIdle { assertEquals(1, opened) }
    }

    @Test
    fun preparedSessionRendersWithNullServerIdAndProfileIsFullWindowWithNestedBackPriority() {
        showNavHost()
        // Mount the real detail after Home before opening Profile: registration order matters.
        selectSession()
        compose.runOnIdle {
            selected = null
            prepared = draft.copy(title = "Prepared without server ID")
        }
        compose.onNodeWithText("Prepared without server ID").assertIsDisplayed()
        val composer = compose.onNode(hasSetTextAction())
        val originalComposerBottom = composer.fetchSemanticsNode().boundsInWindow.bottom
        composer.performClick().performTextInput("Workspace keyboard text")
        compose.onNodeWithText("Workspace keyboard text").assertIsDisplayed()
        compose.waitUntil(5_000) {
            compose.runOnIdle {
                ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
                    ?.isVisible(WindowInsetsCompat.Type.ime()) == true
            }
        }
        val bounds = composer.fetchSemanticsNode().boundsInWindow
        compose.runOnIdle {
            val window = compose.activity.window
            val insets = requireNotNull(ViewCompat.getRootWindowInsets(window.decorView))
            val imeHeight = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val imeTop = compose.activity.windowManager.currentWindowMetrics.bounds.height() - imeHeight
            assertTrue("Native IME must occupy window space", imeHeight > 0)
            assertTrue("IME must cover composer's original position", originalComposerBottom > imeTop)
            assertTrue("Composer must have nonzero visible bounds", bounds.width > 0 && bounds.height > 0)
            assertTrue("Composer $bounds must be above native IME top $imeTop", bounds.bottom <= imeTop)
            WindowCompat.getInsetsController(window, window.decorView).hide(WindowInsetsCompat.Type.ime())
        }
        compose.waitUntil(5_000) {
            compose.runOnIdle {
                ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
                    ?.isVisible(WindowInsetsCompat.Type.ime()) != true
            }
        }
        compose.onNodeWithContentDescription(text(R.string.profile_settings)).performClick()
        val settings = text(R.string.profile_settings)
        compose.onNodeWithText(settings).assertIsDisplayed()
        compose.onNode(hasScrollAction() and hasAnyDescendant(hasText(settings)))
            .assertWidthIsAtLeast(700.dp)
        compose.onNodeWithText(text(R.string.profile_language)).performClick()
        compose.onNodeWithText(settings).assertDoesNotExist()
        pressBack()
        compose.onNodeWithText(settings).assertIsDisplayed()
        compose.runOnIdle { assertEquals(AppDestination.SessionDetail, destination) }
        pressBack()
        compose.onNodeWithText(settings).assertDoesNotExist()
        compose.runOnIdle { assertEquals(AppDestination.SessionDetail, destination) }
        compose.onNodeWithText("Prepared without server ID").assertIsDisplayed()
        openPreparedFilesPage()
        detailTab(R.string.common_files).assertIsDisplayed()
        pressBack()
        compose.onNodeWithText("Prepared without server ID").assertIsDisplayed()
        compose.runOnIdle { assertEquals(AppDestination.SessionDetail, destination) }
        openPreparedFilesPage()
        detailTab(R.string.common_terminal).performClick()
        compose.onNodeWithContentDescription(text(R.string.files_terminal_clear)).assertIsDisplayed()
        pressBack()
        compose.onNodeWithText("Prepared without server ID").assertIsDisplayed()
        compose.onNodeWithText("Workspace keyboard text").assertIsDisplayed()
        compose.runOnIdle { assertEquals(AppDestination.SessionDetail, destination) }
        pressBack()
        compose.onNodeWithText(text(R.string.session_open_from_list)).assertIsDisplayed()
    }

    @Test
    fun sessionMenuBackDismissesOnlyMenuWhileSelectedDetailRemains() {
        showNavHost()
        selectSession()
        sessionRow().performTouchInput { longClick() }
        compose.onNodeWithText(text(R.string.home_rename)).assertIsDisplayed()
        Espresso.pressBack()
        compose.waitForIdle()
        compose.onNodeWithText(text(R.string.home_rename)).assertDoesNotExist()
        sessionRow().assertIsSelected()
        compose.onAllNodesWithText(session.title).assertCountEquals(2)
        compose.runOnIdle {
            assertEquals(AppDestination.SessionDetail, destination)
            assertEquals(session.id, selected)
        }
        pressBack()
        compose.onNodeWithText(text(R.string.session_open_from_list)).assertIsDisplayed()
    }

    @Test
    fun projectMenuBackDismissesOnlyMenuWhileSelectedDetailRemains() {
        showNavHost()
        selectSession()
        compose.runOnIdle { sidebarMode = "project" }
        compose.onNode(hasScrollAction() and hasAnyDescendant(hasText(project.name)))
            .performScrollToNode(hasText(project.name))
        compose.onNodeWithText(project.name).performTouchInput { longClick() }
        compose.onNodeWithText(text(R.string.home_project_edit)).assertIsDisplayed()
        Espresso.pressBack()
        compose.waitForIdle()
        compose.onNodeWithText(text(R.string.home_project_edit)).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(AppDestination.SessionDetail, destination)
            assertEquals(session.id, selected)
            sidebarMode = "session"
        }
        sessionRow().assertIsSelected()
        compose.onAllNodesWithText(session.title).assertCountEquals(2)
        pressBack()
        compose.onNodeWithText(text(R.string.session_open_from_list)).assertIsDisplayed()
    }

    private fun openPreparedFilesPage() {
        compose.onNode(hasScrollAction() and hasAnyDescendant(hasText("Prepared without server ID")))
            .performTouchInput { swipeLeft() }
        detailTab(R.string.common_files).assertIsDisplayed()
    }

    private fun detailTab(id: Int) = compose.onNode(
        hasText(text(id)) and hasClickAction() and
            hasAnyAncestor(SemanticsMatcher.keyIsDefined(SemanticsProperties.HorizontalScrollAxisRange)),
    )

    private fun sessionRow() = compose.onNode(hasText(session.title) and hasClickAction())

    private fun selectSession() {
        compose.onNode(hasScrollAction()).performScrollToNode(hasText(session.title) and hasClickAction())
        sessionRow().performClick()
        compose.waitForIdle()
    }

    private fun pressBack() {
        Espresso.pressBack()
        compose.waitForIdle()
    }

    private fun text(id: Int) = compose.activity.getString(id)

    private fun showNavHost() {
        compose.activityRule.scenario.onActivity {
            // Match MainActivity's manifest soft-input policy.
            it.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f)) {
                AgentsAnywhereTheme {
                    Box(Modifier.requiredWidth(800.dp).fillMaxHeight()) { navHost() }
                }
            }
        }
    }

    @Composable
    private fun navHost() {
        val application = compose.activity.application
        val auth = remember { AuthSessionStore(application) }
        val noAuth = remember {
            object : AuthSessionReader {
                override fun readServerUrl() = ""
                override fun readAccessToken() = ""
            }
        }
        val detail = remember { SessionDetailController(SessionsApi(), noAuth) }
        val realtime = remember { SessionRealtimeController(RealtimeApi(), noAuth, "workspace-test") }
        val files = remember { FilesController(FilesApi(), auth) }
        val terminal = remember { RemoteTerminalPool(TerminalController(TerminalApi(), auth, AuthApi())) }
        val webLogin = remember { WebLoginViewModel(application) }
        val updates = remember { AppUpdateViewModel(application) }
        AgentsAnywhereNavHost(
            currentDestination = destination,
            sessionsState = SessionsState(
                sessions = listOf(session), projects = listOf(project),
                devices = listOf(AgentDevice("device", "Device", online = true)),
                hasLoaded = true,
            ),
            isRefreshingSessions = false, selectedSessionId = selected, preparedSessionDraft = prepared,
            selectedDeviceId = null, deviceDetailReturnDestination = AppDestination.Sessions,
            deviceSetupReturnDestination = AppDestination.Sessions, selectedHomeTab = HomeTab.Active,
            userId = "workspace-nav-test", role = "member", serverUrl = "https://workspace-test.invalid",
            appearanceMode = "light", languageMode = "system", sidebarViewMode = sidebarMode,
            projectSessionsById = emptyMap(), loadingProjectRequests = emptySet(), projectSessionErrors = emptyMap(),
            initialNewSessionProjectId = null, sessionDetailController = detail, sessionRealtimeController = realtime,
            filesController = files, remoteTerminalPool = terminal, pendingMobileLoginQr = null,
            webLoginViewModel = webLogin, appUpdateViewModel = updates,
            navigate = { destination = it }, onRefreshSessions = {}, onLoadMoreSessions = {},
            onOpenSession = { selected = it.id; prepared = null; destination = AppDestination.SessionDetail; opened++ },
            onOpenDevice = {}, onHomeTabSelected = {}, onAppearanceModeChange = {},
            onLanguageModeChange = {}, onSidebarViewModeChange = {},
            onLoadAccount = { Result.success(AuthMeResponse("workspace-nav-test", "member", false, null, "")) },
            onLoadAccountAuthConfig = { unavailable() }, onUpdateDisplayName = { unavailable() },
            onSendEmailCode = { unavailable() }, onBindEmail = { _, _ -> unavailable() },
            onUpdateAvatar = { unavailable() }, onClearAvatar = { unavailable() },
            onChangePassword = { unavailable() }, onSignOut = {},
            onRenameDevice = { _, _ -> unavailable() }, onDeleteDevice = { unavailable() },
            onPrepareDeviceSetup = { unavailable() }, onCreateDeviceSetup = { unavailable() },
            onClaimDevicePairCode = { _, _ -> unavailable() }, devicePairingStates = emptyMap(),
            onWaitForPairingDevice = {}, onClearDevicePairing = {}, onDevicePairingComplete = {},
            onListDeviceRuntimes = { unavailable() }, onSetDeviceRuntimeActive = { _, _, _ -> unavailable() },
            onDeleteDeviceRuntimeConfig = { _, _ -> unavailable() },
            onBulkSetSessionsArchived = { _, _ -> unavailable() },
            onArchiveAllDeviceSessions = { _, _, _ -> unavailable() },
            onRenameSession = { _, _ -> unavailable() }, onSetSessionPinned = { _, _ -> unavailable() },
            onSetSessionArchived = { _, _ -> unavailable() }, onLoadProjectSessions = { _, _ -> },
            onLoadProjects = { Result.success(emptyList()) }, onLoadArchivedPage = { _, _ -> unavailable() },
            onRestoreProject = { unavailable() }, onUpdateProject = { _, _, _ -> unavailable() },
            onArchiveProjectSessions = { unavailable() }, onCreateProject = { _, _, _ -> unavailable() },
            onNewSessionInProject = {},
            onCreateSession = { NewSessionCreateOutcome.Failed(UnsupportedOperationException("Not used")) },
            onPrepareSession = {}, onPreparedSessionCreated = {}, onListDirectory = { _, _, _ -> unavailable() },
            onListNewSessionRuntimes = { unavailable() },
            onLoadNewSessionRuntimeCapabilities = { _, _ -> unavailable() },
            onLoadNewSessionModelCatalog = { _, _ -> unavailable() },
            onLoadNewSessionPermissionCatalog = { _, _ -> unavailable() },
            onSessionChanged = {}, onMobileLoginQrRequested = {},
        )
    }

    private fun <T> unavailable(): Result<T> = Result.failure(UnsupportedOperationException("Not used by smoke test"))
}
