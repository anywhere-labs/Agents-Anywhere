package com.agentsanywhere.app.app

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.agentsanywhere.app.feature.auth.WebLoginViewModel
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.feature.devices.DeviceSetupCredential
import com.agentsanywhere.app.feature.files.FilesController
import com.agentsanywhere.app.feature.realtime.SessionRealtimeController
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessions.NewSessionCreateDraft
import com.agentsanywhere.app.feature.sessions.NewSessionCreateOutcome
import com.agentsanywhere.app.feature.sessions.NewSessionDirectory
import com.agentsanywhere.app.feature.sessions.NewSessionDraft
import com.agentsanywhere.app.feature.sessions.NewSessionModelCatalog
import com.agentsanywhere.app.feature.sessions.NewSessionPermissionCatalog
import com.agentsanywhere.app.feature.sessions.NewSessionRuntimeCapabilities
import com.agentsanywhere.app.feature.sessions.SessionBatchUpdate
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.terminal.RemoteTerminalPool
import com.agentsanywhere.app.feature.update.AppUpdateViewModel
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.MobileLoginQrPayload
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.auth.LoginMethodsScreen
import com.agentsanywhere.app.ui.screens.auth.QrLoginScreen
import com.agentsanywhere.app.ui.screens.auth.QrWaitingScreen
import com.agentsanywhere.app.ui.screens.auth.WebLoginHostScreen
import com.agentsanywhere.app.ui.screens.devices.AddDeviceScreen
import com.agentsanywhere.app.ui.screens.devices.DeviceDetailScreen
import com.agentsanywhere.app.ui.screens.devices.DevicesScreen
import com.agentsanywhere.app.ui.screens.devices.rememberDeviceAgentPreviews
import com.agentsanywhere.app.ui.screens.files.FilesScreen
import com.agentsanywhere.app.ui.screens.home.ArchivedSessionsScreen
import com.agentsanywhere.app.ui.screens.home.HomeScreen
import com.agentsanywhere.app.ui.screens.home.HomeTab
import com.agentsanywhere.app.ui.screens.home.NewSessionScreen
import com.agentsanywhere.app.ui.screens.sessiondetail.SessionComposerDraftStore
import com.agentsanywhere.app.ui.screens.sessiondetail.SessionDetailScreen
import com.agentsanywhere.app.ui.screens.terminal.TerminalScreen

@Composable
internal fun AgentsAnywhereNavHost(
    currentDestination: AppDestination,
    sessionsState: SessionsState,
    isRefreshingSessions: Boolean,
    selectedSessionId: String?,
    preparedSessionDraft: NewSessionDraft?,
    selectedDeviceId: String?,
    deviceDetailReturnDestination: AppDestination,
    deviceSetupReturnDestination: AppDestination,
    selectedHomeTab: HomeTab,
    userId: String,
    role: String,
    serverUrl: String,
    appearanceMode: String,
    languageMode: String,
    sidebarViewMode: String,
    projectSessionsById: Map<String, List<AgentSession>>,
    loadingProjectIds: Set<String>,
    initialNewSessionProjectId: String?,
    sessionDetailController: SessionDetailController,
    sessionRealtimeController: SessionRealtimeController,
    filesController: FilesController,
    remoteTerminalPool: RemoteTerminalPool,
    pendingMobileLoginQr: MobileLoginQrPayload?,
    webLoginViewModel: WebLoginViewModel,
    appUpdateViewModel: AppUpdateViewModel,
    navigate: (AppDestination) -> Unit,
    onRefreshSessions: () -> Unit,
    onLoadMoreSessions: (Boolean) -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    onHomeTabSelected: (HomeTab) -> Unit,
    onAppearanceModeChange: (String) -> Unit,
    onLanguageModeChange: (String) -> Unit,
    onSidebarViewModeChange: (String) -> Unit,
    onLoadAccount: suspend () -> Result<com.agentsanywhere.app.api.AuthMeResponse>,
    onUpdateAvatar: suspend (String) -> Result<com.agentsanywhere.app.api.AuthMeResponse>,
    onClearAvatar: suspend () -> Result<com.agentsanywhere.app.api.AuthMeResponse>,
    onChangePassword: suspend (String) -> Result<Unit>,
    onSignOut: () -> Unit,
    onRenameDevice: suspend (String, String) -> Result<AgentDevice>,
    onDeleteDevice: suspend (String) -> Result<Unit>,
    onPrepareDeviceSetup: suspend (String) -> Result<DeviceSetupCredential>,
    onCreateDeviceSetup: suspend (String) -> Result<DeviceSetupCredential>,
    onClaimDevicePairCode: suspend (DeviceSetupCredential, String) -> Result<AgentDevice>,
    onListDeviceRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
    onSetDeviceRuntimeActive: suspend (String, String, Boolean) -> Result<DeviceRuntime>,
    onDeleteDeviceRuntimeConfig: suspend (String, String) -> Result<DeviceRuntime>,
    onBulkSetSessionsArchived: suspend (List<String>, Boolean) -> Result<SessionBatchUpdate>,
    onArchiveAllDeviceSessions: suspend (String, Boolean, String) -> Result<List<AgentSession>>,
    onRenameSession: suspend (String, String) -> Result<AgentSession>,
    onSetSessionPinned: suspend (String, Boolean) -> Result<AgentSession>,
    onSetSessionArchived: suspend (String, Boolean) -> Result<AgentSession>,
    onLoadProjectSessions: (String) -> Unit,
    onUpdateProject: suspend (String, String?, Boolean?) -> Result<AgentProject>,
    onArchiveProjectSessions: suspend (String) -> Result<List<AgentSession>>,
    onCreateProject: suspend (String, String, String) -> Result<AgentProject>,
    onNewSessionInProject: (AgentProject) -> Unit,
    onCreateSession: suspend (NewSessionCreateDraft) -> NewSessionCreateOutcome,
    onPrepareSession: (NewSessionDraft) -> Unit,
    onPreparedSessionCreated: (AgentSession) -> Unit,
    onListDirectory: suspend (String, String, String) -> Result<NewSessionDirectory>,
    onListNewSessionRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
    onLoadNewSessionRuntimeCapabilities: suspend (String, String) -> Result<NewSessionRuntimeCapabilities>,
    onLoadNewSessionModelCatalog: suspend (String, String) -> Result<NewSessionModelCatalog>,
    onLoadNewSessionPermissionCatalog: suspend (String, String) -> Result<NewSessionPermissionCatalog>,
    onSessionChanged: (AgentSession) -> Unit,
    onMobileLoginQrRequested: (MobileLoginQrPayload) -> Unit,
) {
    val context = LocalContext.current
    val colors = LocalAAColors.current
    var deviceAgentPreviewRefreshKey by remember { mutableLongStateOf(0L) }
    val deviceAgentPreviews = rememberDeviceAgentPreviews(
        devices = sessionsState.devices,
        isRefreshing = isRefreshingSessions,
        refreshKey = deviceAgentPreviewRefreshKey,
        onListDeviceRuntimes = onListDeviceRuntimes,
    )
    val sessionComposerDraftStore = remember(context, userId) {
        SessionComposerDraftStore(context.applicationContext, userId)
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = colors.canvas,
    ) {
        AnimatedContent(
            targetState = currentDestination,
            transitionSpec = {
                val forward = targetState.ordinal > initialState.ordinal
                val enterOffset: (Int) -> Int = { width -> if (forward) width / 5 else -width / 5 }
                val exitOffset: (Int) -> Int = { width -> if (forward) -width / 5 else width / 5 }

                slideInHorizontally(
                    animationSpec = tween(durationMillis = 260),
                    initialOffsetX = enterOffset,
                ) + fadeIn(
                    animationSpec = tween(durationMillis = 180),
                ) togetherWith slideOutHorizontally(
                    animationSpec = tween(durationMillis = 260),
                    targetOffsetX = exitOffset,
                ) + fadeOut(
                    animationSpec = tween(durationMillis = 160),
                )
            },
            label = "App destination transition",
        ) { destination ->
            when (destination) {
                AppDestination.LoginMethods -> LoginMethodsScreen(navigate)
                AppDestination.ServerSetup -> WebLoginHostScreen(webLoginViewModel, navigate)
                AppDestination.QrLogin -> QrLoginScreen(
                    navigate = navigate,
                    onMobileLoginQrRequested = onMobileLoginQrRequested,
                )
                AppDestination.QrWaiting -> QrWaitingScreen(
                    navigate = navigate,
                    mobileLoginQr = pendingMobileLoginQr,
                )
                AppDestination.Sessions -> HomeScreen(
                    navigate = navigate,
                    state = sessionsState,
                    selectedTab = selectedHomeTab,
                    isRefreshing = isRefreshingSessions,
                    userId = userId,
                    role = role,
                    serverUrl = serverUrl,
                    appearanceMode = appearanceMode,
                    languageMode = languageMode,
                    sidebarViewMode = sidebarViewMode,
                    appUpdateViewModel = appUpdateViewModel,
                    projectSessionsById = projectSessionsById,
                    loadingProjectIds = loadingProjectIds,
                    onRefresh = onRefreshSessions,
                    onLoadMore = { tab -> onLoadMoreSessions(tab == HomeTab.Archived) },
                    onTabSelected = onHomeTabSelected,
                    onAppearanceModeChange = onAppearanceModeChange,
                    onLanguageModeChange = onLanguageModeChange,
                    onSidebarViewModeChange = onSidebarViewModeChange,
                    onOpenArchivedSessions = { navigate(AppDestination.ArchivedSessions) },
                    onLoadAccount = onLoadAccount,
                    onUpdateAvatar = onUpdateAvatar,
                    onClearAvatar = onClearAvatar,
                    onChangePassword = onChangePassword,
                    onSignOut = onSignOut,
                    onRenameSession = onRenameSession,
                    onSetSessionPinned = onSetSessionPinned,
                    onSetSessionArchived = onSetSessionArchived,
                    onLoadProjectSessions = onLoadProjectSessions,
                    onUpdateProject = onUpdateProject,
                    onArchiveProjectSessions = onArchiveProjectSessions,
                    onNewSessionInProject = onNewSessionInProject,
                    onOpenSession = onOpenSession,
                    onOpenDevice = onOpenDevice,
                    deviceAgentPreviews = deviceAgentPreviews,
                    onPairDevice = { navigate(AppDestination.DeviceSetup) },
                )
                AppDestination.NewSession -> NewSessionScreen(
                    navigate = navigate,
                    sessionsState = sessionsState,
                    onListDirectory = onListDirectory,
                    onListRuntimes = onListNewSessionRuntimes,
                    onLoadRuntimeCapabilities = onLoadNewSessionRuntimeCapabilities,
                    onLoadModelCatalog = onLoadNewSessionModelCatalog,
                    onLoadPermissionCatalog = onLoadNewSessionPermissionCatalog,
                    onPrepareSession = onPrepareSession,
                    initialProjectId = initialNewSessionProjectId,
                    onCreateProject = onCreateProject,
                )
                AppDestination.SessionDetail -> SessionDetailScreen(
                    navigate = navigate,
                    sessionId = selectedSessionId,
                    initialSession = preparedSessionDraft?.previewSession() ?: sessionsState.sessions
                        .asSequence()
                        .plus(sessionsState.archivedSessions.asSequence())
                        .firstOrNull { it.id == selectedSessionId },
                    preparedSession = preparedSessionDraft,
                    onCreatePreparedSession = onCreateSession,
                    onPreparedSessionCreated = onPreparedSessionCreated,
                    onLoadPreparedModelCatalog = onLoadNewSessionModelCatalog,
                    onLoadPreparedPermissionCatalog = onLoadNewSessionPermissionCatalog,
                    devices = sessionsState.devices,
                    controller = sessionDetailController,
                    realtimeController = sessionRealtimeController,
                    filesController = filesController,
                    terminalPool = remoteTerminalPool,
                    composerDraftStore = sessionComposerDraftStore,
                    onSessionChanged = onSessionChanged,
                )
                AppDestination.DeviceDetail -> DeviceDetailScreen(
                    navigate = navigate,
                    state = sessionsState,
                    selectedDeviceId = selectedDeviceId,
                    backDestination = deviceDetailReturnDestination,
                    onOpenSession = onOpenSession,
                    onRenameDevice = onRenameDevice,
                    onDeleteDevice = onDeleteDevice,
                    onPrepareDeviceSetup = onPrepareDeviceSetup,
                    onClaimDevicePairCode = onClaimDevicePairCode,
                    onListDeviceRuntimes = onListDeviceRuntimes,
                    onSetDeviceRuntimeActive = { connectorId, runtime, active ->
                        onSetDeviceRuntimeActive(connectorId, runtime, active).onSuccess {
                            deviceAgentPreviewRefreshKey += 1L
                        }
                    },
                    onDeleteDeviceRuntimeConfig = { connectorId, runtime ->
                        onDeleteDeviceRuntimeConfig(connectorId, runtime).onSuccess {
                            deviceAgentPreviewRefreshKey += 1L
                        }
                    },
                    onBulkSetSessionsArchived = onBulkSetSessionsArchived,
                    onArchiveAllDeviceSessions = onArchiveAllDeviceSessions,
                )
                AppDestination.Devices -> DevicesScreen(
                    state = sessionsState,
                    isRefreshing = isRefreshingSessions,
                    onRefresh = onRefreshSessions,
                    onOpenDevice = onOpenDevice,
                    onBack = { navigate(AppDestination.Sessions) },
                    agentPreviews = deviceAgentPreviews,
                    onAddDevice = { navigate(AppDestination.DeviceSetup) },
                )
                AppDestination.Terminal -> TerminalScreen(
                    navigate = navigate,
                    state = sessionsState,
                    terminalPool = remoteTerminalPool,
                    onPairDevice = { navigate(AppDestination.DeviceSetup) },
                )
                AppDestination.Files -> FilesScreen(
                    navigate = navigate,
                    state = sessionsState,
                    controller = filesController,
                    onPairDevice = { navigate(AppDestination.DeviceSetup) },
                )
                AppDestination.DeviceSetup -> AddDeviceScreen(
                    devices = sessionsState.devices,
                    onBack = { navigate(deviceSetupReturnDestination) },
                    onCreateCredential = onCreateDeviceSetup,
                    onRenameDevice = onRenameDevice,
                )
                AppDestination.ArchivedSessions -> ArchivedSessionsScreen(
                    onBack = { navigate(AppDestination.Sessions) },
                )
            }
        }
    }
}
