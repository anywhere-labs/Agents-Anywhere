package com.agentsanywhere.app.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Network
import android.net.Uri
import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.api.DevicesApi
import com.agentsanywhere.app.api.FilesApi
import com.agentsanywhere.app.api.RealtimeApi
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.TerminalApi
import com.agentsanywhere.app.feature.auth.AuthController
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.auth.WebLoginState
import com.agentsanywhere.app.feature.auth.WebLoginViewModel
import com.agentsanywhere.app.feature.update.AppUpdateViewModel
import com.agentsanywhere.app.feature.devices.DevicesController
import com.agentsanywhere.app.feature.files.FilesController
import com.agentsanywhere.app.feature.realtime.DashboardRealtimeController
import com.agentsanywhere.app.feature.realtime.RealtimeClientIdStore
import com.agentsanywhere.app.feature.realtime.SessionRealtimeController
import com.agentsanywhere.app.feature.sessions.SessionsController
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.sessions.NewSessionCreateOutcome
import com.agentsanywhere.app.feature.sessions.NewSessionDraft
import com.agentsanywhere.app.feature.sessions.beginSessionRequest
import com.agentsanywhere.app.feature.sessions.mergedWithRefresh
import com.agentsanywhere.app.feature.sessions.replacedByDashboardSnapshot
import com.agentsanywhere.app.feature.sessions.withDeletedDevice
import com.agentsanywhere.app.feature.sessions.withPatchedDevice
import com.agentsanywhere.app.feature.sessions.withPatchedProject
import com.agentsanywhere.app.feature.sessions.withPatchedSession
import com.agentsanywhere.app.feature.sessions.withPatchedSessions
import com.agentsanywhere.app.feature.sessions.withMissingSessionsRemoved
import com.agentsanywhere.app.feature.sessions.withAppendedSessionPage
import com.agentsanywhere.app.feature.sessions.withSessionPageLoading
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.terminal.RemoteTerminalPool
import com.agentsanywhere.app.feature.terminal.TerminalController
import com.agentsanywhere.app.model.MobileLoginQrPayload
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import com.agentsanywhere.app.ui.designsystem.AALanguageMode
import com.agentsanywhere.app.ui.screens.home.HomeTab
import com.agentsanywhere.app.ui.screens.update.AppUpdatePromptDialog
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import java.io.File

@Composable
fun AgentsAnywhereApp(
    appearanceMode: String = "system",
    languageMode: String = AALanguageMode.System,
    sidebarViewMode: String = com.agentsanywhere.app.ui.screens.home.HomeSidebarViewMode.Project,
    onAppearanceModeChange: (String) -> Unit = {},
    onLanguageModeChange: (String) -> Unit = {},
    onSidebarViewModeChange: (String) -> Unit = {},
    oauthCallbackUri: Uri? = null,
    onOAuthCallbackConsumed: () -> Unit = {},
    webLoginViewModel: WebLoginViewModel,
    appUpdateViewModel: AppUpdateViewModel,
    onInstallUpdate: (File) -> Unit = {},
) {
    val context = LocalContext.current
    val sessionStore = remember(context) { AuthSessionStore(context) }
    var destinationName by rememberSaveable {
        mutableStateOf(
            if (sessionStore.hasAuthSession()) {
                AppDestination.Sessions.name
            } else {
                AppDestination.LoginMethods.name
            },
        )
    }
    var pendingMobileLoginQr by remember { mutableStateOf<MobileLoginQrPayload?>(null) }
    var selectedSessionId by rememberSaveable { mutableStateOf<String?>(null) }
    var initialNewSessionProjectId by rememberSaveable { mutableStateOf<String?>(null) }
    var preparedSessionDraft by rememberSaveable(stateSaver = NewSessionDraftSaver) {
        mutableStateOf<NewSessionDraft?>(null)
    }
    var selectedDeviceId by rememberSaveable { mutableStateOf<String?>(null) }
    var deviceDetailReturnDestinationName by rememberSaveable { mutableStateOf(AppDestination.Devices.name) }
    var deviceSetupReturnDestinationName by rememberSaveable { mutableStateOf(AppDestination.Devices.name) }
    var selectedHomeTabName by rememberSaveable { mutableStateOf(HomeTab.Active.name) }
    val unauthorizedTokens = remember { Channel<String>(capacity = Channel.UNLIMITED) }
    val apiClient = remember(unauthorizedTokens) {
        ApiClient(onUnauthorized = { accessToken ->
            unauthorizedTokens.trySend(accessToken)
        })
    }
    val realtimeApi = remember(apiClient) { RealtimeApi(client = apiClient) }
    val realtimeClientId = remember(context) { RealtimeClientIdStore(context).readOrCreate() }
    val authController = remember(context, sessionStore, apiClient) {
        AuthController(
            api = AuthApi(apiClient),
            sessionStore = sessionStore,
        )
    }
    val sessionsController = remember(context, sessionStore, apiClient) {
        SessionsController(
            sessionsApi = SessionsApi(apiClient),
            devicesApi = DevicesApi(apiClient),
            filesApi = FilesApi(apiClient),
            sessionStore = sessionStore,
        )
    }
    val devicesController = remember(context, sessionStore, apiClient) {
        DevicesController(
            devicesApi = DevicesApi(apiClient),
            sessionStore = sessionStore,
        )
    }
    val sessionDetailController = remember(context, sessionStore, apiClient) {
        SessionDetailController(
            sessionsApi = SessionsApi(apiClient),
            sessionStore = sessionStore,
        )
    }
    val filesController = remember(context, sessionStore, apiClient) {
        FilesController(
            filesApi = FilesApi(apiClient),
            sessionStore = sessionStore,
        )
    }
    val terminalController = remember(context, sessionStore, apiClient) {
        TerminalController(
            terminalApi = TerminalApi(apiClient),
            sessionStore = sessionStore,
        )
    }
    val remoteTerminalPool = remember(terminalController) {
        RemoteTerminalPool(terminalController)
    }
    val dashboardRealtimeController = remember(realtimeApi, sessionStore, realtimeClientId) {
        DashboardRealtimeController(realtimeApi, sessionStore, realtimeClientId)
    }
    val sessionRealtimeController = remember(realtimeApi, sessionStore, realtimeClientId) {
        SessionRealtimeController(realtimeApi, sessionStore, realtimeClientId)
    }
    val currentDestination = AppDestination.valueOf(destinationName)
    val hasAuthSession = sessionStore.hasAuthSession()
    var sessionsState by remember(sessionsController) {
        mutableStateOf(
            if (hasAuthSession) {
                SessionsState(isLoading = true)
            } else {
                SessionsState()
            },
        )
    }
    var isRefreshingSessions by remember { mutableStateOf(false) }
    var projectSessionsById by remember { mutableStateOf<Map<String, List<AgentSession>>>(emptyMap()) }
    var loadingProjectIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    var appVisible by remember(lifecycleOwner) {
        mutableStateOf(lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
    }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> appVisible = true
                Lifecycle.Event.ON_STOP -> appVisible = false
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        appVisible = lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    DisposableEffect(context, dashboardRealtimeController, sessionRealtimeController) {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val networkWasLost = AtomicBoolean(false)
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (networkWasLost.getAndSet(false)) {
                    dashboardRealtimeController.requestImmediateReconnect()
                    sessionRealtimeController.requestImmediateReconnect()
                }
            }

            override fun onLost(network: Network) {
                networkWasLost.set(true)
            }
        }
        connectivity.registerDefaultNetworkCallback(callback)
        onDispose { connectivity.unregisterNetworkCallback(callback) }
    }
    fun clearSessionAndReturnToLogin(expectedToken: String? = null) {
        val didClearSession = if (expectedToken == null) {
            authController.signOut()
            true
        } else {
            sessionStore.clearAuthSessionIfTokenMatches(expectedToken)
        }
        if (!didClearSession) return

        remoteTerminalPool.disposeLocal()
        sessionsState = SessionsState()
        isRefreshingSessions = false
        projectSessionsById = emptyMap()
        loadingProjectIds = emptySet()
        selectedSessionId = null
        initialNewSessionProjectId = null
        preparedSessionDraft = null
        selectedDeviceId = null
        pendingMobileLoginQr = null
        webLoginViewModel.resetForSignedOutEntry()
        destinationName = AppDestination.LoginMethods.name
    }

    LaunchedEffect(unauthorizedTokens) {
        for (accessToken in unauthorizedTokens) {
            clearSessionAndReturnToLogin(expectedToken = accessToken)
        }
    }

    DisposableEffect(lifecycleOwner, hasAuthSession, authController, context) {
        if (!hasAuthSession) {
            return@DisposableEffect onDispose {}
        }

        var validationJob: Job? = null
        fun validateSessionIfOnline() {
            if (!context.hasUsableNetwork() || validationJob?.isActive == true) return
            validationJob = scope.launch {
                authController.me()
            }
        }

        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) {
                validateSessionIfOnline()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            validateSessionIfOnline()
        }

        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            validationJob?.cancel()
        }
    }

    suspend fun refreshSessions(showInitialLoading: Boolean, showRefreshIndicator: Boolean) {
        val request = sessionsState.beginSessionRequest()
        sessionsState = request.state
        if (showRefreshIndicator) {
            isRefreshingSessions = true
        } else if (showInitialLoading && !sessionsState.hasLoaded && sessionsState.sessions.isEmpty() && sessionsState.devices.isEmpty()) {
            sessionsState = sessionsState.copy(isLoading = true, errorMessage = null)
        }

        try {
            sessionsController.loadSessions()
                .onSuccess { loadedState ->
                    sessionsState = sessionsState.mergedWithRefresh(loadedState, request.generation)
                }
                .onFailure { error ->
                    val hasAnyCachedData = sessionsState.sessions.isNotEmpty() || sessionsState.devices.isNotEmpty()
                    val initialLoadFailed = !sessionsState.hasLoaded && !hasAnyCachedData
                    sessionsState = sessionsState.copy(
                        isLoading = false,
                        errorMessage = when {
                            initialLoadFailed -> error.message ?: "Could not load sessions."
                            hasAnyCachedData -> null
                            else -> sessionsState.errorMessage
                        },
                        hasLoaded = sessionsState.hasLoaded || hasAnyCachedData,
                    )
                }
        } finally {
            if (showRefreshIndicator) {
                isRefreshingSessions = false
            }
        }
    }
    fun loadMoreSessions(archived: Boolean) {
        val hasMore = if (archived) sessionsState.archivedHasMore else sessionsState.activeHasMore
        val cursor = if (archived) sessionsState.archivedNextCursor else sessionsState.activeNextCursor
        val loading = if (archived) sessionsState.isLoadingMoreArchived else sessionsState.isLoadingMoreActive
        if (!hasMore || cursor == null || loading) return
        sessionsState = sessionsState.withSessionPageLoading(archived, true)
        scope.launch {
            sessionsController.loadMoreSessions(
                archived = archived,
                cursor = cursor,
                devices = sessionsState.devices,
            ).onSuccess { page ->
                sessionsState = sessionsState.withAppendedSessionPage(page)
            }.onFailure {
                sessionsState = sessionsState.withSessionPageLoading(archived, false)
            }
        }
    }

    fun loadProjectSessions(projectId: String) {
        if (projectId.isBlank() || projectId in loadingProjectIds) return
        loadingProjectIds = loadingProjectIds + projectId
        scope.launch {
            sessionsController.loadProjectSessions(projectId, sessionsState.devices)
                .onSuccess { sessions ->
                    projectSessionsById = projectSessionsById + (projectId to sessions)
                }
            loadingProjectIds = loadingProjectIds - projectId
        }
    }

    val navigate: (AppDestination) -> Unit = { destination ->
        if (destination == AppDestination.QrLogin) {
            pendingMobileLoginQr = null
        }
        if (destination == AppDestination.LoginMethods) {
            webLoginViewModel.returnToHostChoice()
        }
        if (
            destination == AppDestination.ServerSetup &&
            destinationName == AppDestination.LoginMethods.name
        ) {
            webLoginViewModel.returnToHostChoice()
        }
        if (destination != AppDestination.SessionDetail) {
            preparedSessionDraft = null
        }
        if (destination == AppDestination.NewSession) {
            initialNewSessionProjectId = null
        }
        if (
            destination == AppDestination.DeviceSetup &&
            destinationName != AppDestination.DeviceSetup.name
        ) {
            deviceSetupReturnDestinationName = destinationName
        }
        destinationName = destination.name
    }

    val realtimeServerUrl = sessionStore.readServerUrl()
    val realtimeAccessToken = sessionStore.readAccessToken()
    LaunchedEffect(
        hasAuthSession,
        appVisible,
        realtimeServerUrl,
        realtimeAccessToken,
        dashboardRealtimeController,
    ) {
        if (!hasAuthSession) {
            sessionsState = SessionsState()
            return@LaunchedEffect
        }
        if (!appVisible) return@LaunchedEffect
        dashboardRealtimeController.start(
            scope = this,
            onSnapshot = { snapshot ->
                scope.launch {
                    if (sessionStore.readServerUrl() != realtimeServerUrl ||
                        sessionStore.readAccessToken() != realtimeAccessToken
                    ) return@launch
                    sessionsState = sessionsState.replacedByDashboardSnapshot(
                        sessionsController.dashboardSnapshotState(snapshot),
                    )
                }
            },
            onInitialFailure = {
                scope.launch {
                    if (sessionStore.readServerUrl() != realtimeServerUrl ||
                        sessionStore.readAccessToken() != realtimeAccessToken
                    ) return@launch
                    if (!sessionsState.hasLoaded) {
                        refreshSessions(showInitialLoading = true, showRefreshIndicator = false)
                    }
                }
            },
        ).join()
    }

    LaunchedEffect(oauthCallbackUri) {
        val uri = oauthCallbackUri ?: return@LaunchedEffect
        if (currentDestination == AppDestination.ServerSetup &&
            webLoginViewModel.state is WebLoginState.WebLogin
        ) {
            webLoginViewModel.handleCallback(uri.toString())
        }
        onOAuthCallbackConsumed()
    }

    AgentsAnywhereNavHost(
        currentDestination = currentDestination,
        sessionsState = sessionsState,
        isRefreshingSessions = isRefreshingSessions,
        selectedSessionId = selectedSessionId,
        preparedSessionDraft = preparedSessionDraft,
        selectedDeviceId = selectedDeviceId,
        deviceDetailReturnDestination = AppDestination.valueOf(deviceDetailReturnDestinationName),
        deviceSetupReturnDestination = AppDestination.valueOf(deviceSetupReturnDestinationName),
        selectedHomeTab = HomeTab.valueOf(selectedHomeTabName),
        userId = authController.savedUserId(),
        role = authController.savedRole(),
        serverUrl = authController.savedServerUrl(),
        appearanceMode = appearanceMode,
        languageMode = languageMode,
        sidebarViewMode = sidebarViewMode,
        projectSessionsById = projectSessionsById,
        loadingProjectIds = loadingProjectIds,
        initialNewSessionProjectId = initialNewSessionProjectId,
        sessionDetailController = sessionDetailController,
        sessionRealtimeController = sessionRealtimeController,
        filesController = filesController,
        remoteTerminalPool = remoteTerminalPool,
        pendingMobileLoginQr = pendingMobileLoginQr,
        webLoginViewModel = webLoginViewModel,
        appUpdateViewModel = appUpdateViewModel,
        navigate = navigate,
        onRefreshSessions = {
            if (!hasAuthSession || isRefreshingSessions) return@AgentsAnywhereNavHost
            scope.launch {
                refreshSessions(
                    showInitialLoading = false,
                    showRefreshIndicator = true,
                )
            }
        },
        onLoadMoreSessions = ::loadMoreSessions,
        onOpenSession = { session ->
            preparedSessionDraft = null
            selectedSessionId = session.id
            destinationName = AppDestination.SessionDetail.name
            if (session.unread) {
                val request = sessionsState.beginSessionRequest(listOf(session.id))
                sessionsState = request.state
                scope.launch {
                    sessionsController.markSessionRead(session.id, sessionsState.devices)
                        .onSuccess { updated ->
                            sessionsState = sessionsState.withPatchedSession(updated, request.generation)
                        }
                        .onFailure { error ->
                            Toast.makeText(
                                context,
                                error.message ?: "Could not mark this session as read.",
                                Toast.LENGTH_SHORT,
                            ).show()
                        }
                }
            }
        },
        onOpenDevice = { device ->
            deviceDetailReturnDestinationName = destinationName
            selectedDeviceId = device.id
            destinationName = AppDestination.DeviceDetail.name
        },
        onHomeTabSelected = { tab ->
            selectedHomeTabName = tab.name
        },
        onAppearanceModeChange = onAppearanceModeChange,
        onLanguageModeChange = onLanguageModeChange,
        onSidebarViewModeChange = onSidebarViewModeChange,
        onLoadAccount = { authController.me() },
        onUpdateAvatar = { avatar -> authController.updateAvatar(avatar) },
        onClearAvatar = { authController.clearAvatar() },
        onChangePassword = { password -> authController.changePassword(password) },
        onSignOut = {
            clearSessionAndReturnToLogin()
        },
        onRenameDevice = { connectorId, name ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to rename this device."))
            } else {
                devicesController.renameDevice(connectorId, name)
                    .onSuccess { device ->
                        sessionsState = sessionsState.withPatchedDevice(device)
                    }
            }
        },
        onDeleteDevice = { connectorId ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to delete this device."))
            } else {
                devicesController.deleteDevice(connectorId)
                    .onSuccess {
                        sessionsState = sessionsState.withDeletedDevice(connectorId)
                        if (selectedDeviceId == connectorId) selectedDeviceId = null
                        destinationName = AppDestination.Devices.name
                    }
            }
        },
        onPrepareDeviceSetup = { connectorId ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to set up this device."))
            } else {
                devicesController.prepareDeviceSetup(connectorId)
                    .onSuccess { credential ->
                        sessionsState = sessionsState.withPatchedDevice(credential.device)
                    }
            }
        },
        onCreateDeviceSetup = { name ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to pair a new device."))
            } else {
                devicesController.createDeviceSetup(name)
                    .onSuccess { credential ->
                        sessionsState = sessionsState.withPatchedDevice(credential.device)
                    }
            }
        },
        onClaimDevicePairCode = { credential, code ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to claim this pair code."))
            } else {
                devicesController.claimDevicePairCode(credential, code)
                    .onSuccess { device ->
                        sessionsState = sessionsState.withPatchedDevice(device)
                    }
            }
        },
        onListDeviceRuntimes = { connectorId ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to load runtimes."))
            } else {
                devicesController.listDeviceRuntimes(connectorId)
            }
        },
        onSetDeviceRuntimeActive = { connectorId, runtime, active ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to update this runtime."))
            } else {
                devicesController.setDeviceRuntimeActive(connectorId, runtime, active)
            }
        },
        onDeleteDeviceRuntimeConfig = { connectorId, runtime ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to delete runtime configuration."))
            } else {
                devicesController.deleteDeviceRuntimeConfig(connectorId, runtime)
            }
        },
        onBulkSetSessionsArchived = { ids, archived ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to update sessions."))
            } else {
                val request = sessionsState.beginSessionRequest(ids)
                sessionsState = request.state
                sessionsController.bulkSetSessionsArchived(ids, archived, sessionsState.devices)
                    .onSuccess { update ->
                        sessionsState = sessionsState
                            .withPatchedSessions(update.sessions, request.generation)
                            .withMissingSessionsRemoved(update.notFound, request.generation)
                    }
            }
        },
        onArchiveAllDeviceSessions = { connectorId, archived, scope ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to update sessions."))
            } else {
                val targetIds = (sessionsState.sessions + sessionsState.archivedSessions)
                    .filter { session ->
                        session.connectorId == connectorId && when (scope) {
                            "active" -> !session.archived
                            "archived" -> session.archived
                            else -> true
                        }
                    }
                    .map { it.id }
                val request = sessionsState.beginSessionRequest(targetIds)
                sessionsState = request.state
                sessionsController.archiveAllDeviceSessions(connectorId, archived, scope, sessionsState.devices)
                    .onSuccess { sessions ->
                        sessionsState = sessionsState.withPatchedSessions(sessions, request.generation)
                    }
            }
        },
        onRenameSession = { sessionId, title ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to update this session."))
            } else {
                val request = sessionsState.beginSessionRequest(listOf(sessionId))
                sessionsState = request.state
                sessionsController.renameSession(sessionId, title, sessionsState.devices)
                    .onSuccess { session ->
                        sessionsState = sessionsState.withPatchedSession(session, request.generation)
                    }
            }
        },
        onSetSessionPinned = { sessionId, pinned ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to update this session."))
            } else {
                val request = sessionsState.beginSessionRequest(listOf(sessionId))
                sessionsState = request.state
                sessionsController.setSessionPinned(sessionId, pinned, sessionsState.devices)
                    .onSuccess { session ->
                        sessionsState = sessionsState.withPatchedSession(session, request.generation)
                    }
            }
        },
        onSetSessionArchived = { sessionId, archived ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to update this session."))
            } else {
                val request = sessionsState.beginSessionRequest(listOf(sessionId))
                sessionsState = request.state
                sessionsController.setSessionArchived(sessionId, archived, sessionsState.devices)
                    .onSuccess { session ->
                        sessionsState = sessionsState.withPatchedSession(session, request.generation)
                    }
            }
        },
        onLoadProjectSessions = ::loadProjectSessions,
        onUpdateProject = { projectId, name, pinned ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to update this project."))
            } else {
                sessionsController.updateProject(projectId, name, pinned)
                    .onSuccess { project ->
                        sessionsState = sessionsState.withPatchedProject(project)
                    }
            }
        },
        onArchiveProjectSessions = { projectId ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to archive project sessions."))
            } else {
                val targetIds = (projectSessionsById[projectId].orEmpty() + sessionsState.sessions)
                    .filter { it.projectId == projectId && !it.archived }
                    .map(AgentSession::id)
                    .distinct()
                val request = sessionsState.beginSessionRequest(targetIds)
                sessionsState = request.state
                sessionsController.archiveProjectSessions(projectId, sessionsState.devices)
                    .onSuccess { sessions ->
                        sessionsState = sessionsState.withPatchedSessions(sessions, request.generation)
                        projectSessionsById = projectSessionsById + (projectId to emptyList())
                    }
            }
        },
        onCreateProject = { name, connectorId, workspacePath ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to create a project."))
            } else {
                sessionsController.createProject(name, connectorId, workspacePath)
                    .onSuccess { project ->
                        sessionsState = sessionsState.withPatchedProject(project)
                    }
            }
        },
        onNewSessionInProject = { project ->
            initialNewSessionProjectId = project.id
            destinationName = AppDestination.NewSession.name
        },
        onCreateSession = { draft ->
            if (!hasAuthSession) {
                NewSessionCreateOutcome.Failed(IllegalStateException("Sign in again to create a session."))
            } else {
                val refresh = sessionsState.beginSessionRequest()
                sessionsState = refresh.state
                val outcome = sessionsController.createAndStartSession(
                    draft = draft,
                    devices = sessionsState.devices,
                )
                val refreshedState = when (outcome) {
                    is NewSessionCreateOutcome.Created -> outcome.refreshedState
                    is NewSessionCreateOutcome.Failed -> outcome.refreshedState
                }
                if (refreshedState != null) {
                    sessionsState = sessionsState.mergedWithRefresh(refreshedState, refresh.generation)
                }
                if (outcome is NewSessionCreateOutcome.Created) {
                    sessionsState = sessionsState.withPatchedSession(outcome.session, refresh.generation)
                }
                outcome
            }
        },
        onPrepareSession = { draft ->
            preparedSessionDraft = draft
            selectedSessionId = null
            destinationName = AppDestination.SessionDetail.name
        },
        onPreparedSessionCreated = { session ->
            sessionsState = sessionsState.withPatchedSession(session)
            preparedSessionDraft = null
            selectedSessionId = session.id
        },
        onListDirectory = { connectorId, root, path ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to browse files."))
            } else {
                sessionsController.listNewSessionDirectory(
                    connectorId = connectorId,
                    root = root,
                    path = path,
                )
            }
        },
        onListNewSessionRuntimes = { connectorId ->
            sessionsController.listNewSessionRuntimes(connectorId)
        },
        onLoadNewSessionRuntimeCapabilities = { connectorId, runtime ->
            sessionsController.loadNewSessionRuntimeCapabilities(connectorId, runtime)
        },
        onLoadNewSessionModelCatalog = { connectorId, runtime ->
            sessionsController.loadNewSessionModelCatalog(connectorId, runtime)
        },
        onLoadNewSessionPermissionCatalog = { connectorId, runtime ->
            sessionsController.loadNewSessionPermissionCatalog(connectorId, runtime)
        },
        onSessionChanged = { session ->
            sessionsState = sessionsState.withPatchedSession(session)
        },
        onMobileLoginQrRequested = { payload ->
            pendingMobileLoginQr = payload
            destinationName = AppDestination.QrWaiting.name
        },
    )
    AppUpdatePromptDialog(
        state = appUpdateViewModel.state,
        onUpdate = appUpdateViewModel::downloadUpdate,
        onLater = appUpdateViewModel::dismissPrompt,
        onCancelDownload = appUpdateViewModel::cancelDownload,
    )
    LaunchedEffect(appUpdateViewModel.state.installFile) {
        appUpdateViewModel.state.installFile?.let(onInstallUpdate)
    }
}


private fun Context.hasUsableNetwork(): Boolean {
    val connectivityManager = getSystemService(ConnectivityManager::class.java)
    val activeNetwork = connectivityManager.activeNetwork ?: return false
    val capabilities = connectivityManager.getNetworkCapabilities(activeNetwork) ?: return false
    return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
}

private val NewSessionDraftSaver = listSaver<NewSessionDraft?, Any>(
    save = { draft ->
        if (draft == null) {
            emptyList()
        } else {
            listOf(
                draft.connectorId,
                draft.runtime,
                draft.title.orEmpty(),
                draft.cwd.orEmpty(),
                draft.deviceName,
                draft.runtimeLabel,
                ArrayList(draft.knownSessionIds),
                draft.selections.model.orEmpty(),
                draft.selections.permission.orEmpty(),
                draft.runtimeId,
                draft.runtimeType,
                draft.runtimeName,
                draft.attachmentsEnabled,
                draft.localSessionId,
                draft.projectId,
            )
        }
    },
    restore = { values ->
        if (values.isEmpty()) {
            null
        } else {
            @Suppress("UNCHECKED_CAST")
            NewSessionDraft(
                connectorId = values[0] as String,
                runtime = values[1] as String,
                title = (values[2] as String).takeIf(String::isNotBlank),
                cwd = (values[3] as String).takeIf(String::isNotBlank),
                deviceName = values[4] as String,
                runtimeLabel = values[5] as String,
                knownSessionIds = (values[6] as ArrayList<String>).toSet(),
                selections = com.agentsanywhere.app.feature.sessions.NewSessionSelections(
                    model = (values[7] as String).takeIf(String::isNotBlank),
                    permission = (values[8] as String).takeIf(String::isNotBlank),
                ),
                runtimeId = (values.getOrNull(9) as? String)?.takeIf(String::isNotBlank)
                    ?: values[1] as String,
                runtimeType = (values.getOrNull(10) as? String)?.takeIf(String::isNotBlank)
                    ?: values[1] as String,
                runtimeName = (values.getOrNull(11) as? String)?.takeIf(String::isNotBlank)
                    ?: values[5] as String,
                attachmentsEnabled = values.getOrNull(12) as? Boolean ?: true,
                localSessionId = (values.getOrNull(13) as? String)?.takeIf(String::isNotBlank)
                    ?: (values.getOrNull(12) as? String)?.takeIf(String::isNotBlank)
                    ?: com.agentsanywhere.app.feature.sessions.NewSessionDraft.newLocalSessionId(),
                projectId = (values.getOrNull(14) as? String).orEmpty(),
            )
        }
    },
)

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun AgentsAnywhereAppPreview() {
    AgentsAnywhereTheme {
        val context = LocalContext.current
        val application = context.applicationContext as android.app.Application
        AgentsAnywhereApp(
            webLoginViewModel = WebLoginViewModel(application),
            appUpdateViewModel = AppUpdateViewModel(application),
        )
    }
}
