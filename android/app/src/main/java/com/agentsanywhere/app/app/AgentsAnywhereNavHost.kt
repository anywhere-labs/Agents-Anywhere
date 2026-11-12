package com.agentsanywhere.app.app

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.res.stringResource
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.screens.devices.DeviceConfirmDialog
import kotlinx.coroutines.CancellationException
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.feature.auth.WebLoginViewModel
import com.agentsanywhere.app.feature.devices.DeviceAgentOperations
import com.agentsanywhere.app.feature.devices.hasConfiguredDeviceAgents
import com.agentsanywhere.app.feature.devices.observingChanges
import com.agentsanywhere.app.feature.devices.DevicePairingStatus
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.feature.devices.DeviceSetupCredential
import com.agentsanywhere.app.feature.devices.DeviceSettingsOperations
import com.agentsanywhere.app.feature.files.FilesController
import com.agentsanywhere.app.feature.modelconfig.ModelConfigController
import com.agentsanywhere.app.feature.modelconfig.ModelConfigState
import com.agentsanywhere.app.feature.realtime.SessionRealtimeController
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessions.NewSessionCreateDraft
import com.agentsanywhere.app.feature.sessions.NewSessionCreateOutcome
import com.agentsanywhere.app.feature.sessions.NewSessionDirectory
import com.agentsanywhere.app.feature.sessions.NewSessionDraft
import com.agentsanywhere.app.feature.sessions.ProjectSessionLoadKey
import com.agentsanywhere.app.feature.sessions.ProjectSessionStatusFilter
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
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.auth.LoginMethodsScreen
import com.agentsanywhere.app.ui.screens.auth.QrLoginScreen
import com.agentsanywhere.app.ui.screens.auth.QrWaitingScreen
import com.agentsanywhere.app.ui.screens.auth.WebLoginHostScreen
import com.agentsanywhere.app.ui.screens.devices.AddDeviceScreen
import com.agentsanywhere.app.ui.screens.devices.DeviceAgentSetupSheet
import com.agentsanywhere.app.ui.screens.devices.DeviceDetailScreen
import com.agentsanywhere.app.ui.screens.devices.DevicesScreen
import com.agentsanywhere.app.ui.screens.devices.rememberDeviceAgentPreviews
import com.agentsanywhere.app.ui.screens.files.FilesScreen
import com.agentsanywhere.app.ui.screens.home.ArchivedSessionsScreen
import com.agentsanywhere.app.ui.screens.home.HomeScreen
import com.agentsanywhere.app.ui.screens.home.HomeTab
import com.agentsanywhere.app.ui.screens.home.NewSessionScreen
import com.agentsanywhere.app.ui.screens.modelconfig.ModelConfigScreen
import com.agentsanywhere.app.ui.screens.profile.ProfileSettingsDrawer
import com.agentsanywhere.app.ui.screens.sessiondetail.SessionComposerDraftStore
import com.agentsanywhere.app.ui.screens.sessiondetail.SessionDetailScreen
import com.agentsanywhere.app.ui.screens.terminal.TerminalScreen
import kotlinx.coroutines.launch

@Composable
internal fun AgentsAnywhereNavHost(
    currentDestination: AppDestination,
    sessionsState: SessionsState,
    modelConfigState: ModelConfigState,
    modelConfigController: ModelConfigController,
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
    loadingProjectRequests: Set<ProjectSessionLoadKey>,
    projectSessionErrors: Map<ProjectSessionLoadKey, String>,
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
    onLoadAccountAuthConfig: suspend () -> Result<com.agentsanywhere.app.api.AuthConfigResponse>,
    onUpdateDisplayName: suspend (String) -> Result<com.agentsanywhere.app.api.AuthMeResponse>,
    onSendEmailCode: suspend (String) -> Result<com.agentsanywhere.app.api.EmailCodeResponse>,
    onBindEmail: suspend (String, String?) -> Result<com.agentsanywhere.app.api.AuthMeResponse>,
    onUpdateAvatar: suspend (String) -> Result<com.agentsanywhere.app.api.AuthMeResponse>,
    onClearAvatar: suspend () -> Result<com.agentsanywhere.app.api.AuthMeResponse>,
    onChangePassword: suspend (String) -> Result<Unit>,
    onSignOut: () -> Unit,
    onRenameDevice: suspend (String, String) -> Result<AgentDevice>,
    onDeleteDevice: suspend (String) -> Result<Unit>,
    onPrepareDeviceSetup: suspend (String) -> Result<DeviceSetupCredential>,
    onCreateDeviceSetup: suspend (String) -> Result<DeviceSetupCredential>,
    onClaimDevicePairCode: suspend (DeviceSetupCredential, String) -> Result<AgentDevice>,
    devicePairingStates: Map<String, DevicePairingStatus>,
    onWaitForPairingDevice: (String) -> Unit,
    onClearDevicePairing: (String) -> Unit,
    onDevicePairingComplete: () -> Unit,
    onListDeviceRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
    deviceAgents: DeviceAgentOperations,
    deviceSettings: DeviceSettingsOperations,
    onBulkSetSessionsArchived: suspend (List<String>, Boolean) -> Result<SessionBatchUpdate>,
    onArchiveAllDeviceSessions: suspend (String, Boolean, String) -> Result<List<AgentSession>>,
    onRenameSession: suspend (String, String) -> Result<AgentSession>,
    onSetSessionPinned: suspend (String, Boolean) -> Result<AgentSession>,
    onSetSessionArchived: suspend (String, Boolean) -> Result<AgentSession>,
    onLoadProjectSessions: (String, ProjectSessionStatusFilter) -> Unit,
    onLoadProjects: suspend () -> Result<List<AgentProject>>,
    onLoadArchivedPage: suspend (String?, String?) -> Result<com.agentsanywhere.app.feature.sessions.SessionPageAppend>,
    onRestoreProject: suspend (String) -> Result<List<AgentSession>>,
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
    onPrepareRuntimeWorkspace: suspend (String, String, String) -> Result<com.agentsanywhere.app.feature.sessions.PreparedRuntimeWorkspace>,
    onLoadNewSessionModelCatalog: suspend (String, String) -> Result<NewSessionModelCatalog>,
    onLoadNewSessionPermissionCatalog: suspend (String, String) -> Result<NewSessionPermissionCatalog>,
    onSessionChanged: (AgentSession) -> Unit,
    onMobileLoginQrRequested: (MobileLoginQrPayload) -> Unit,
) {
    val context = LocalContext.current
    val colors = LocalAAColors.current
    var profileOpen by rememberSaveable(serverUrl, userId) { mutableStateOf(false) }
    var deviceAgentPreviewRefreshKey by remember { mutableLongStateOf(0L) }
    val deviceAgentPreviews = rememberDeviceAgentPreviews(
        devices = sessionsState.devices,
        isRefreshing = isRefreshingSessions,
        refreshKey = deviceAgentPreviewRefreshKey,
        onListDeviceRuntimes = onListDeviceRuntimes,
    )
    // Agent counts on the device list follow every Agent change made in this app.
    val agentOperations = remember(deviceAgents) {
        deviceAgents.observingChanges { deviceAgentPreviewRefreshKey += 1L }
    }
    val checkAgents: suspend () -> Result<Boolean> = {
        runCatching { hasConfiguredDeviceAgents(sessionsState.devices, onListDeviceRuntimes) }
    }
    var agentSetupDeviceIds by remember(serverUrl, userId) { mutableStateOf(emptyList<String>()) }
    // A device page under the setup sheet reads its Agents again once the sheet closes.
    var agentSetupFinishedCount by remember(serverUrl, userId) { mutableLongStateOf(0L) }
    val showsWorkspace = currentDestination in workspaceDestinations
    var agentReminderChecked by remember(serverUrl, userId) { mutableStateOf(false) }
    var agentReminderOpen by remember(serverUrl, userId) { mutableStateOf(false) }
    LaunchedEffect(currentDestination, sessionsState.hasLoaded, sessionsState.devices, isRefreshingSessions, serverUrl, userId) {
        if (currentDestination == AppDestination.DeviceSetup) agentReminderChecked = false
        if (currentDestination != AppDestination.Sessions || !sessionsState.hasLoaded ||
            sessionsState.isLoading || isRefreshingSessions || sessionsState.errorMessage != null || agentReminderChecked) return@LaunchedEffect
        try {
            val configured = hasConfiguredDeviceAgents(sessionsState.devices, onListDeviceRuntimes)
            agentReminderChecked = true
            agentReminderOpen = !configured
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { /* Unknown inventory must not be treated as empty. */ }
    }
    // A device that came online after its setup page was left is offered Agent setup here.
    val onlinePairings = devicePairingStates.filterValues { it == DevicePairingStatus.Online }.keys
    LaunchedEffect(onlinePairings, showsWorkspace, agentSetupDeviceIds) {
        if (!showsWorkspace || agentSetupDeviceIds.isNotEmpty()) return@LaunchedEffect
        val id = onlinePairings.firstOrNull() ?: return@LaunchedEffect
        onClearDevicePairing(id)
        if (sessionsState.devices.any { it.id == id }) agentSetupDeviceIds = listOf(id)
    }
    if (agentReminderOpen && currentDestination == AppDestination.Sessions && !profileOpen && agentSetupDeviceIds.isEmpty()) {
        DeviceConfirmDialog(
            title = stringResource(R.string.agent_reminder_title),
            body = stringResource(R.string.agent_reminder_description),
            confirmLabel = stringResource(R.string.agent_reminder_add),
            dismissLabel = stringResource(R.string.agent_reminder_later),
            onDismiss = { agentReminderOpen = false },
            onConfirm = {
                agentReminderOpen = false
                val online = sessionsState.devices.filter { it.online }
                when {
                    online.isNotEmpty() -> agentSetupDeviceIds = online.map { it.id }
                    sessionsState.devices.isNotEmpty() -> onOpenDevice(sessionsState.devices.first())
                    else -> navigate(AppDestination.DeviceSetup)
                }
            },
        )
    }
    val agentSetupDevices = agentSetupDeviceIds.mapNotNull { id -> sessionsState.devices.firstOrNull { it.id == id } }
    if (agentSetupDevices.isNotEmpty() && showsWorkspace) {
        DeviceAgentSetupSheet(
            devices = agentSetupDevices,
            operations = agentOperations,
            onCheckAgents = checkAgents,
            onFinish = {
                agentSetupDeviceIds = emptyList()
                agentSetupFinishedCount += 1L
            },
        )
    } else if (agentSetupDeviceIds.isNotEmpty() && agentSetupDevices.isEmpty()) {
        // The devices were deleted or the account changed while the setup was pending.
        LaunchedEffect(Unit) { agentSetupDeviceIds = emptyList() }
    }
    val sessionComposerDraftStore = remember(context, userId) {
        SessionComposerDraftStore(context.applicationContext, userId)
    }

    key(serverUrl, userId) {
        val workspaceStateHolder = rememberSaveableStateHolder()
        var sidebarCollapsed by rememberSaveable { mutableStateOf(false) }
        val profileNotices = remember { SnackbarHostState() }
        val profileScope = rememberCoroutineScope()
        val animationDestination = when (currentDestination) {
            AppDestination.SessionDetail -> AppDestination.Sessions
            else -> currentDestination
        }
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = colors.canvas,
        ) {
            Box(Modifier.fillMaxSize()) {
                AnimatedContent(
                    targetState = animationDestination,
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
                        AppDestination.Sessions, AppDestination.SessionDetail -> SessionWorkspace(
                            showDetail = currentDestination == AppDestination.SessionDetail,
                            detailKey = (selectedSessionId ?: preparedSessionDraft?.localSessionId)?.let { "session:$it" },
                            stateHolder = workspaceStateHolder,
                            sidebarCollapsed = sidebarCollapsed,
                            onSidebarCollapsedChange = { sidebarCollapsed = it },
                            home = { compact, onCollapse ->
                                HomeScreen(
                                    navigate = navigate,
                                    state = sessionsState,
                                    selectedTab = selectedHomeTab,
                                    onLoadProjects = onLoadProjects,
                                    isRefreshing = isRefreshingSessions,
                                    userId = userId,
                                    serverUrl = serverUrl,
                                    sidebarViewMode = sidebarViewMode,
                                    projectSessionsById = projectSessionsById,
                                    loadingProjectRequests = loadingProjectRequests,
                                    projectSessionErrors = projectSessionErrors,
                                    onRefresh = onRefreshSessions,
                                    onLoadMore = { tab -> onLoadMoreSessions(tab == HomeTab.Archived) },
                                    onTabSelected = onHomeTabSelected,
                                    profileOpen = profileOpen,
                                    onProfileOpenChange = { profileOpen = it },
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
                                    selectedSessionId = selectedSessionId.takeIf { currentDestination == AppDestination.SessionDetail },
                                    compact = compact,
                                    onCollapseSidebar = onCollapse,
                                )
                            },
                            detail = {
                                SessionDetailScreen(
                                    navigate = navigate,
                                    sessionId = selectedSessionId,
                                    initialSession = preparedSessionDraft?.previewSession()
                                        ?: sessionsState.sessions.asSequence()
                                            .plus(sessionsState.archivedSessions.asSequence())
                                            .plus(projectSessionsById.values.asSequence().flatten())
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
                                    backHandlingEnabled = !profileOpen,
                                    onSessionChanged = onSessionChanged,
                                )
                            },
                        )
                        AppDestination.NewSession, AppDestination.NewProject -> androidx.compose.runtime.key(serverUrl, userId, destination) { NewSessionScreen(
                            navigate = navigate,
                            sessionsState = sessionsState,
                            projectSessionsById = projectSessionsById,
                            serverUrl = serverUrl,
                            userId = userId,
                            onListDirectory = onListDirectory,
                            onListRuntimes = onListNewSessionRuntimes,
                            onLoadRuntimeCapabilities = onLoadNewSessionRuntimeCapabilities,
                            onLoadModelCatalog = onLoadNewSessionModelCatalog,
                            onLoadPermissionCatalog = onLoadNewSessionPermissionCatalog,
                            modelConfigState = modelConfigState,
                            onPrepareSession = onPrepareSession,
                            onRefreshDevices = onRefreshSessions,
                            devicesRefreshing = isRefreshingSessions,
                            initialProjectId = initialNewSessionProjectId.takeIf { destination == AppDestination.NewSession },
                            projectOnly = destination == AppDestination.NewProject,
                            sidebarViewMode = sidebarViewMode,
                            onLoadProjects = onLoadProjects,
                            onCreateProject = onCreateProject,
                        ) }
                        AppDestination.DeviceDetail -> DeviceDetailScreen(
                            navigate = navigate,
                            state = sessionsState,
                            selectedDeviceId = selectedDeviceId,
                            backDestination = deviceDetailReturnDestination,
                            onOpenSession = onOpenSession,
                            onRenameDevice = onRenameDevice,
                            onDeleteDevice = onDeleteDevice,
                            onPrepareDeviceSetup = onPrepareDeviceSetup,
                            agentOperations = agentOperations,
                            deviceSettings = deviceSettings,
                            agentsRefreshKey = agentSetupFinishedCount,
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
                        AppDestination.DeviceSetup -> androidx.compose.runtime.key(serverUrl, userId) {
                            AddDeviceScreen(
                                agentOperations = agentOperations,
                                onCheckAgents = checkAgents,
                                devices = sessionsState.devices,
                                pairingStates = devicePairingStates,
                                onBack = { navigate(deviceSetupReturnDestination) },
                                onComplete = {
                                    onDevicePairingComplete()
                                    navigate(deviceSetupReturnDestination)
                                },
                                onCreateCredential = onCreateDeviceSetup,
                                onRenameDevice = onRenameDevice,
                                onClaimPairCode = onClaimDevicePairCode,
                                onWaitForDevice = onWaitForPairingDevice,
                                onClearPairing = onClearDevicePairing,
                            )
                        }
                        AppDestination.ArchivedSessions -> androidx.compose.runtime.key(serverUrl, userId) {
                            ArchivedSessionsScreen(
                                projects = sessionsState.projects,
                                onLoadPage = onLoadArchivedPage,
                                onRestoreSession = { onSetSessionArchived(it, false) },
                                onRestoreProject = onRestoreProject,
                                onBack = { navigate(AppDestination.Sessions) },
                            )
                        }
                        AppDestination.ModelConfig -> key(serverUrl, userId) {
                            ModelConfigScreen(
                                state = modelConfigState,
                                devices = sessionsState.devices,
                                controller = modelConfigController,
                                onBack = { navigate(AppDestination.Sessions) },
                            )
                        }
                    }
                }
                ProfileSettingsDrawer(
                    open = profileOpen,
                    userId = userId,
                    role = role,
                    serverUrl = serverUrl,
                    appearanceMode = appearanceMode,
                    languageMode = languageMode,
                    sidebarViewMode = sidebarViewMode,
                    appUpdateViewModel = appUpdateViewModel,
                    onAppearanceModeChange = onAppearanceModeChange,
                    onLanguageModeChange = onLanguageModeChange,
                    onSidebarViewModeChange = onSidebarViewModeChange,
                    onLoadAccount = onLoadAccount,
                    onLoadAccountAuthConfig = onLoadAccountAuthConfig,
                    onUpdateDisplayName = onUpdateDisplayName,
                    onSendEmailCode = onSendEmailCode,
                    onBindEmail = onBindEmail,
                    onUpdateAvatar = onUpdateAvatar,
                    onClearAvatar = onClearAvatar,
                    onChangePassword = onChangePassword,
                    onOpenArchivedSessions = {
                        profileOpen = false
                        navigate(AppDestination.ArchivedSessions)
                    },
                    onOpenModelConfig = {
                        profileOpen = false
                        navigate(AppDestination.ModelConfig)
                    },
                    onSignOut = onSignOut,
                    onClose = { profileOpen = false },
                    onNotice = { message, isError ->
                        profileScope.launch {
                            profileNotices.showSnackbar(
                                AAToastVisuals(
                                    message = message,
                                    isError = isError,
                                    duration = if (isError) SnackbarDuration.Long else SnackbarDuration.Short,
                                ),
                            )
                        }
                    },
                )
                AAToastHost(
                    hostState = profileNotices,
                    modifier = Modifier.align(Alignment.TopCenter)
                        .padding(top = 86.dp, start = 22.dp, end = 22.dp),
                )
            }
        }
    }
}

/** Destinations of a signed-in workspace, where Agent setup can be offered over the page. */
private val workspaceDestinations = AppDestination.entries.toSet() - setOf(
    AppDestination.LoginMethods,
    AppDestination.ServerSetup,
    AppDestination.QrLogin,
    AppDestination.QrWaiting,
    AppDestination.DeviceSetup,
)
