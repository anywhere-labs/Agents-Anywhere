package com.agentsanywhere.app.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Network
import android.net.Uri
import android.widget.Toast
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
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
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.feature.devices.DeviceRuntimeSetupResult
import com.agentsanywhere.app.feature.devices.DeviceSetupCredential
import com.agentsanywhere.app.feature.devices.DevicesController
import com.agentsanywhere.app.feature.files.FilesController
import com.agentsanywhere.app.feature.realtime.DashboardRealtimeController
import com.agentsanywhere.app.feature.realtime.RealtimeClientIdStore
import com.agentsanywhere.app.feature.realtime.SessionRealtimeController
import com.agentsanywhere.app.feature.sessions.SessionsController
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.sessions.SessionBatchUpdate
import com.agentsanywhere.app.feature.sessions.NewSessionDirectory
import com.agentsanywhere.app.feature.sessions.NewSessionCreateDraft
import com.agentsanywhere.app.feature.sessions.NewSessionCreateOutcome
import com.agentsanywhere.app.feature.sessions.NewSessionDraft
import com.agentsanywhere.app.feature.sessions.NewSessionModelCatalog
import com.agentsanywhere.app.feature.sessions.NewSessionPermissionCatalog
import com.agentsanywhere.app.feature.sessions.NewSessionRuntimeCapabilities
import com.agentsanywhere.app.feature.sessions.beginSessionRequest
import com.agentsanywhere.app.feature.sessions.mergedWithRefresh
import com.agentsanywhere.app.feature.sessions.replacedByDashboardSnapshot
import com.agentsanywhere.app.feature.sessions.withDeletedDevice
import com.agentsanywhere.app.feature.sessions.withPatchedDevice
import com.agentsanywhere.app.feature.sessions.withPatchedSession
import com.agentsanywhere.app.feature.sessions.withPatchedSessions
import com.agentsanywhere.app.feature.sessions.withMissingSessionsRemoved
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.terminal.RemoteTerminalPool
import com.agentsanywhere.app.feature.terminal.TerminalController
import com.agentsanywhere.app.model.MobileLoginQrPayload
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import com.agentsanywhere.app.ui.designsystem.AALanguageMode
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.auth.LoginMethodsScreen
import com.agentsanywhere.app.ui.screens.auth.QrLoginScreen
import com.agentsanywhere.app.ui.screens.auth.QrWaitingScreen
import com.agentsanywhere.app.ui.screens.auth.WebLoginHostScreen
import com.agentsanywhere.app.ui.screens.devices.DeviceDetailScreen
import com.agentsanywhere.app.ui.screens.devices.DevicesScreen
import com.agentsanywhere.app.ui.screens.devices.PairNewDeviceSheetHost
import com.agentsanywhere.app.ui.screens.devices.rememberDeviceAgentPreviews
import com.agentsanywhere.app.ui.screens.files.FilesScreen
import com.agentsanywhere.app.ui.screens.sessiondetail.SessionComposerDraftStore
import com.agentsanywhere.app.ui.screens.sessiondetail.SessionDetailScreen
import com.agentsanywhere.app.ui.screens.home.HomeTab
import com.agentsanywhere.app.ui.screens.home.HomeScreen
import com.agentsanywhere.app.ui.screens.home.NewSessionScreen
import com.agentsanywhere.app.ui.screens.terminal.TerminalScreen
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
    onAppearanceModeChange: (String) -> Unit = {},
    onLanguageModeChange: (String) -> Unit = {},
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
    var preparedSessionDraft by rememberSaveable(stateSaver = NewSessionDraftSaver) {
        mutableStateOf<NewSessionDraft?>(null)
    }
    var selectedDeviceId by rememberSaveable { mutableStateOf<String?>(null) }
    var deviceDetailReturnDestinationName by rememberSaveable { mutableStateOf(AppDestination.Devices.name) }
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
        selectedSessionId = null
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
        selectedHomeTab = HomeTab.valueOf(selectedHomeTabName),
        userId = authController.savedUserId(),
        role = authController.savedRole(),
        serverUrl = authController.savedServerUrl(),
        appearanceMode = appearanceMode,
        languageMode = languageMode,
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
        onDiscoverDeviceRuntimes = { connectorId ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to discover runtimes."))
            } else {
                devicesController.discoverDeviceRuntimes(connectorId)
            }
        },
        onConfigureAndStartDeviceRuntime = { connectorId, runtime, config ->
            if (!hasAuthSession) {
                DeviceRuntimeSetupResult.SaveFailed(
                    IllegalStateException("Sign in again to configure this runtime."),
                )
            } else {
                devicesController.configureAndStartDeviceRuntime(connectorId, runtime, config)
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

@Composable
private fun AgentsAnywhereNavHost(
    currentDestination: AppDestination,
    sessionsState: SessionsState,
    isRefreshingSessions: Boolean,
    selectedSessionId: String?,
    preparedSessionDraft: NewSessionDraft?,
    selectedDeviceId: String?,
    deviceDetailReturnDestination: AppDestination,
    selectedHomeTab: HomeTab,
    userId: String,
    role: String,
    serverUrl: String,
    appearanceMode: String,
    languageMode: String,
    sessionDetailController: SessionDetailController,
    sessionRealtimeController: SessionRealtimeController,
    filesController: FilesController,
    remoteTerminalPool: RemoteTerminalPool,
    pendingMobileLoginQr: MobileLoginQrPayload?,
    webLoginViewModel: WebLoginViewModel,
    appUpdateViewModel: AppUpdateViewModel,
    navigate: (AppDestination) -> Unit,
    onRefreshSessions: () -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    onHomeTabSelected: (HomeTab) -> Unit,
    onAppearanceModeChange: (String) -> Unit,
    onLanguageModeChange: (String) -> Unit,
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
    onDiscoverDeviceRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
    onConfigureAndStartDeviceRuntime: suspend (String, String, Map<String, Any?>) -> DeviceRuntimeSetupResult,
    onSetDeviceRuntimeActive: suspend (String, String, Boolean) -> Result<DeviceRuntime>,
    onDeleteDeviceRuntimeConfig: suspend (String, String) -> Result<DeviceRuntime>,
    onBulkSetSessionsArchived: suspend (List<String>, Boolean) -> Result<SessionBatchUpdate>,
    onArchiveAllDeviceSessions: suspend (String, Boolean, String) -> Result<List<AgentSession>>,
    onRenameSession: suspend (String, String) -> Result<com.agentsanywhere.app.model.AgentSession>,
    onSetSessionPinned: suspend (String, Boolean) -> Result<com.agentsanywhere.app.model.AgentSession>,
    onSetSessionArchived: suspend (String, Boolean) -> Result<com.agentsanywhere.app.model.AgentSession>,
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
    var pairDeviceSheetOpen by remember { mutableStateOf(false) }
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
                    appUpdateViewModel = appUpdateViewModel,
                    onRefresh = onRefreshSessions,
                    onTabSelected = onHomeTabSelected,
                    onAppearanceModeChange = onAppearanceModeChange,
                    onLanguageModeChange = onLanguageModeChange,
                    onLoadAccount = onLoadAccount,
                    onUpdateAvatar = onUpdateAvatar,
                    onClearAvatar = onClearAvatar,
                    onChangePassword = onChangePassword,
                    onSignOut = onSignOut,
                    onRenameSession = onRenameSession,
                    onSetSessionPinned = onSetSessionPinned,
                    onSetSessionArchived = onSetSessionArchived,
                    onOpenSession = onOpenSession,
                    onOpenDevice = onOpenDevice,
                    deviceAgentPreviews = deviceAgentPreviews,
                    onPairDevice = { pairDeviceSheetOpen = true },
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
                    onDiscoverDeviceRuntimes = { connectorId ->
                        onDiscoverDeviceRuntimes(connectorId).onSuccess {
                            deviceAgentPreviewRefreshKey += 1L
                        }
                    },
                    onConfigureAndStartDeviceRuntime = { connectorId, runtime, config ->
                        onConfigureAndStartDeviceRuntime(connectorId, runtime, config).also { result ->
                            if (result !is DeviceRuntimeSetupResult.SaveFailed) {
                                deviceAgentPreviewRefreshKey += 1L
                            }
                        }
                    },
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
                    onCreateDeviceSetup = onCreateDeviceSetup,
                    onDeviceCredentialCreated = { credential ->
                        // The create callback already patches state; this keeps the screen API explicit.
                    },
                    onClaimDevicePairCode = onClaimDevicePairCode,
                )
                AppDestination.Terminal -> TerminalScreen(
                    navigate = navigate,
                    state = sessionsState,
                    terminalPool = remoteTerminalPool,
                    onPairDevice = { pairDeviceSheetOpen = true },
                )
                AppDestination.Files -> FilesScreen(
                    navigate = navigate,
                    state = sessionsState,
                    controller = filesController,
                    onPairDevice = { pairDeviceSheetOpen = true },
                )
            }
        }
        PairNewDeviceSheetHost(
            open = pairDeviceSheetOpen,
            devices = sessionsState.devices,
            onDismiss = { pairDeviceSheetOpen = false },
            onCreateDeviceSetup = onCreateDeviceSetup,
            onDeviceCredentialCreated = {},
            onClaimDevicePairCode = onClaimDevicePairCode,
        )
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
