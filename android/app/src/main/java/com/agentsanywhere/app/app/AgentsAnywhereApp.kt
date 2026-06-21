package com.agentsanywhere.app.app

import android.net.Uri
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.api.ConnectorsApi
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthController
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.auth.OAuthCallbackResult
import com.agentsanywhere.app.feature.auth.OAuthFlowState
import com.agentsanywhere.app.feature.sessions.DeviceSetupCredential
import com.agentsanywhere.app.feature.sessions.SessionsController
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.sessions.NewSessionDirectory
import com.agentsanywhere.app.feature.sessions.withDeletedDevice
import com.agentsanywhere.app.feature.sessions.withDeletedDeviceAgent
import com.agentsanywhere.app.feature.sessions.withPatchedDevice
import com.agentsanywhere.app.feature.sessions.withPatchedSession
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.model.MobileLoginQrPayload
import com.agentsanywhere.app.feature.auth.OAuthPendingStatus
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.navigation.selectedTab
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.auth.CreateAccountScreen
import com.agentsanywhere.app.ui.screens.auth.LoginMethodsScreen
import com.agentsanywhere.app.ui.screens.auth.OAuthCreateAccountScreen
import com.agentsanywhere.app.ui.screens.auth.OAuthLinkExistingAccountScreen
import com.agentsanywhere.app.ui.screens.auth.OAuthRegistrationClosedErrorScreen
import com.agentsanywhere.app.ui.screens.auth.OAuthRegistrationClosedScreen
import com.agentsanywhere.app.ui.screens.auth.OAuthSetupScreen
import com.agentsanywhere.app.ui.screens.auth.PasswordLoginScreen
import com.agentsanywhere.app.ui.screens.auth.QrLoginScreen
import com.agentsanywhere.app.ui.screens.auth.QrWaitingScreen
import com.agentsanywhere.app.ui.screens.auth.ServerSetupScreen
import com.agentsanywhere.app.ui.screens.devices.DeviceDetailScreen
import com.agentsanywhere.app.ui.screens.sessiondetail.SessionDetailScreen
import com.agentsanywhere.app.ui.screens.home.HomeTabsScreen
import com.agentsanywhere.app.ui.screens.sessions.NewSessionScreen
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun AgentsAnywhereApp(
    oauthCallbackUri: Uri? = null,
    onOAuthCallbackConsumed: () -> Unit = {},
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
    var oauthFlow by remember { mutableStateOf<OAuthFlowState?>(null) }
    var oauthErrorMessage by remember { mutableStateOf<String?>(null) }
    var selectedSessionId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedDeviceId by rememberSaveable { mutableStateOf<String?>(null) }
    val authController = remember(context, sessionStore) {
        AuthController(
            api = AuthApi(),
            sessionStore = sessionStore,
        )
    }
    val sessionsController = remember(context, sessionStore) {
        SessionsController(
            sessionsApi = SessionsApi(),
            connectorsApi = ConnectorsApi(),
            sessionStore = sessionStore,
        )
    }
    val sessionDetailController = remember(context, sessionStore) {
        SessionDetailController(
            sessionsApi = SessionsApi(),
            connectorsApi = ConnectorsApi(),
            sessionStore = sessionStore,
        )
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
    suspend fun refreshSessions(showInitialLoading: Boolean, showRefreshIndicator: Boolean) {
        if (showRefreshIndicator) {
            isRefreshingSessions = true
        } else if (showInitialLoading && !sessionsState.hasLoaded && sessionsState.sessions.isEmpty() && sessionsState.devices.isEmpty()) {
            sessionsState = sessionsState.copy(isLoading = true, errorMessage = null)
        }

        try {
            sessionsController.loadSessions()
                .onSuccess { loadedState ->
                    sessionsState = loadedState
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
            oauthFlow = null
            oauthErrorMessage = null
        }
        destinationName = destination.name
    }

    LaunchedEffect(hasAuthSession, sessionsController) {
        if (!hasAuthSession) {
            sessionsState = SessionsState()
            return@LaunchedEffect
        }

        while (true) {
            refreshSessions(
                showInitialLoading = true,
                showRefreshIndicator = false,
            )
            delay(5_000)
        }
    }

    LaunchedEffect(oauthCallbackUri) {
        val uri = oauthCallbackUri ?: return@LaunchedEffect
        when (val result = authController.parseOAuthCallback(uri)) {
            is OAuthCallbackResult.Pending -> {
                val serverUrl = authController.savedServerUrl()
                oauthErrorMessage = null
                oauthFlow = OAuthFlowState(serverUrl = serverUrl, pending = result.pending)
                when (result.pending.status) {
                    OAuthPendingStatus.Authenticated -> {
                        authController.finalizeAuthenticatedOAuth(
                            serverUrl = serverUrl,
                            pendingToken = result.pending.pendingToken,
                        ).onSuccess {
                            oauthFlow = null
                            destinationName = AppDestination.Sessions.name
                        }.onFailure { error ->
                            oauthFlow = null
                            oauthErrorMessage = error.message ?: "OAuth sign-in failed."
                            destinationName = AppDestination.OAuthSetup.name
                        }
                    }
                    OAuthPendingStatus.NeedsPassword -> {
                        destinationName = AppDestination.OAuthLinkExisting.name
                    }
                    OAuthPendingStatus.NeedsRegistration -> {
                        authController.authConfig(serverUrl)
                            .onSuccess { config ->
                                destinationName = if (config.oauthRegistrationOpen) {
                                    AppDestination.OAuthCreateAccount.name
                                } else {
                                    AppDestination.OAuthRegistrationClosed.name
                                }
                            }
                            .onFailure { error ->
                                oauthErrorMessage = error.message ?: "Could not check auth configuration."
                                destinationName = AppDestination.OAuthSetup.name
                            }
                    }
                }
            }
            is OAuthCallbackResult.Error -> {
                oauthFlow = null
                oauthErrorMessage = result.message
                destinationName = AppDestination.OAuthSetup.name
            }
            null -> Unit
        }
        onOAuthCallbackConsumed()
    }

    AgentsAnywhereNavHost(
        currentDestination = currentDestination,
        sessionsState = sessionsState,
        isRefreshingSessions = isRefreshingSessions,
        selectedSessionId = selectedSessionId,
        selectedDeviceId = selectedDeviceId,
        sessionDetailController = sessionDetailController,
        pendingMobileLoginQr = pendingMobileLoginQr,
        oauthFlow = oauthFlow,
        oauthErrorMessage = oauthErrorMessage,
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
            selectedSessionId = session.id
            destinationName = AppDestination.SessionDetail.name
        },
        onOpenDevice = { device ->
            selectedDeviceId = device.id
            destinationName = AppDestination.DeviceDetail.name
        },
        onRenameDevice = { connectorId, name ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to rename this device."))
            } else {
                sessionsController.renameDevice(connectorId, name)
                    .onSuccess { device ->
                        sessionsState = sessionsState.withPatchedDevice(device)
                    }
            }
        },
        onDeleteDevice = { connectorId ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to delete this device."))
            } else {
                sessionsController.deleteDevice(connectorId)
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
                sessionsController.prepareDeviceSetup(connectorId)
                    .onSuccess { credential ->
                        sessionsState = sessionsState.withPatchedDevice(credential.device)
                    }
            }
        },
        onClaimDevicePairCode = { credential, code ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to claim this pair code."))
            } else {
                sessionsController.claimDevicePairCode(credential, code)
                    .onSuccess { device ->
                        sessionsState = sessionsState.withPatchedDevice(device)
                    }
            }
        },
        onDeleteDeviceAgent = { connectorId, runtime ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to remove this agent."))
            } else {
                sessionsController.deleteDeviceAgent(connectorId, runtime)
                    .onSuccess { attached ->
                        sessionsState = sessionsState.withDeletedDeviceAgent(connectorId, runtime, attached)
                    }
            }
        },
        onRenameSession = { sessionId, title ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to update this session."))
            } else {
                sessionsController.renameSession(sessionId, title, sessionsState.devices)
                    .onSuccess { session ->
                        sessionsState = sessionsState.withPatchedSession(session)
                    }
            }
        },
        onSetSessionPinned = { sessionId, pinned ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to update this session."))
            } else {
                sessionsController.setSessionPinned(sessionId, pinned, sessionsState.devices)
                    .onSuccess { session ->
                        sessionsState = sessionsState.withPatchedSession(session)
                    }
            }
        },
        onSetSessionArchived = { sessionId, archived ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to update this session."))
            } else {
                sessionsController.setSessionArchived(sessionId, archived, sessionsState.devices)
                    .onSuccess { session ->
                        sessionsState = sessionsState.withPatchedSession(session)
                    }
            }
        },
        onCreateSession = { title, connectorId, runtime, cwd ->
            if (!hasAuthSession) {
                Result.failure(IllegalStateException("Sign in again to create a session."))
            } else {
                sessionsController.createSession(
                    title = title,
                    connectorId = connectorId,
                    runtime = runtime,
                    cwd = cwd,
                    devices = sessionsState.devices,
                ).onSuccess { session ->
                    sessionsState = sessionsState.withPatchedSession(session)
                }
            }
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
        onSessionChanged = { session ->
            sessionsState = sessionsState.withPatchedSession(session)
        },
        onMobileLoginQrRequested = { payload ->
            pendingMobileLoginQr = payload
            destinationName = AppDestination.QrWaiting.name
        },
        onOAuthPendingReceived = { flow, destination ->
            oauthFlow = flow
            oauthErrorMessage = null
            destinationName = destination.name
        },
        onOAuthErrorConsumed = { oauthErrorMessage = null },
    )
}

@Composable
private fun AgentsAnywhereNavHost(
    currentDestination: AppDestination,
    sessionsState: SessionsState,
    isRefreshingSessions: Boolean,
    selectedSessionId: String?,
    selectedDeviceId: String?,
    sessionDetailController: SessionDetailController,
    pendingMobileLoginQr: MobileLoginQrPayload?,
    oauthFlow: OAuthFlowState?,
    oauthErrorMessage: String?,
    navigate: (AppDestination) -> Unit,
    onRefreshSessions: () -> Unit,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    onRenameDevice: suspend (String, String) -> Result<AgentDevice>,
    onDeleteDevice: suspend (String) -> Result<Unit>,
    onPrepareDeviceSetup: suspend (String) -> Result<DeviceSetupCredential>,
    onClaimDevicePairCode: suspend (DeviceSetupCredential, String) -> Result<AgentDevice>,
    onDeleteDeviceAgent: suspend (String, String) -> Result<List<String>>,
    onRenameSession: suspend (String, String) -> Result<com.agentsanywhere.app.model.AgentSession>,
    onSetSessionPinned: suspend (String, Boolean) -> Result<com.agentsanywhere.app.model.AgentSession>,
    onSetSessionArchived: suspend (String, Boolean) -> Result<com.agentsanywhere.app.model.AgentSession>,
    onCreateSession: suspend (String, String, String, String) -> Result<com.agentsanywhere.app.model.AgentSession>,
    onListDirectory: suspend (String, String, String) -> Result<NewSessionDirectory>,
    onSessionChanged: (AgentSession) -> Unit,
    onMobileLoginQrRequested: (MobileLoginQrPayload) -> Unit,
    onOAuthPendingReceived: (OAuthFlowState, AppDestination) -> Unit,
    onOAuthErrorConsumed: () -> Unit,
) {
    val colors = LocalAAColors.current

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = colors.canvas,
    ) {
        val animatedDestination = when (currentDestination) {
            AppDestination.Sessions,
            AppDestination.Devices,
            AppDestination.Profile -> AppDestination.Sessions
            else -> currentDestination
        }

        AnimatedContent(
            targetState = animatedDestination,
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
                AppDestination.ServerSetup -> ServerSetupScreen(navigate)
                AppDestination.PasswordLogin -> PasswordLoginScreen(navigate)
                AppDestination.CreateAccount -> CreateAccountScreen(navigate)
                AppDestination.OAuthSetup -> OAuthSetupScreen(
                    navigate = navigate,
                    errorMessage = oauthErrorMessage,
                    onErrorConsumed = onOAuthErrorConsumed,
                )
                AppDestination.OAuthLinkExisting -> OAuthLinkExistingAccountScreen(
                    navigate = navigate,
                    flowState = oauthFlow,
                )
                AppDestination.OAuthRegistrationClosed -> OAuthRegistrationClosedScreen(navigate)
                AppDestination.OAuthCreateAccount -> OAuthCreateAccountScreen(
                    navigate = navigate,
                    flowState = oauthFlow,
                    onOAuthPendingReceived = onOAuthPendingReceived,
                )
                AppDestination.OAuthRegistrationClosedError -> OAuthRegistrationClosedErrorScreen(
                    navigate = navigate,
                    flowState = oauthFlow,
                )
                AppDestination.QrLogin -> QrLoginScreen(
                    navigate = navigate,
                    onMobileLoginQrRequested = onMobileLoginQrRequested,
                )
                AppDestination.QrWaiting -> QrWaitingScreen(
                    navigate = navigate,
                    mobileLoginQr = pendingMobileLoginQr,
                )
                AppDestination.Sessions -> HomeTabsScreen(
                    selectedTab = currentDestination.selectedTab()
                        ?: AppDestination.Sessions.selectedTab()
                        ?: error("Sessions tab is not configured."),
                    sessionsState = sessionsState,
                    isRefreshingSessions = isRefreshingSessions,
                    onRefreshSessions = onRefreshSessions,
                    onRenameSession = onRenameSession,
                    onSetSessionPinned = onSetSessionPinned,
                    onSetSessionArchived = onSetSessionArchived,
                    onOpenSession = onOpenSession,
                    onOpenDevice = onOpenDevice,
                    navigate = navigate,
                )
                AppDestination.NewSession -> NewSessionScreen(
                    navigate = navigate,
                    sessionsState = sessionsState,
                    onCreateSession = onCreateSession,
                    onListDirectory = onListDirectory,
                    onOpenSession = onOpenSession,
                )
                AppDestination.SessionDetail -> SessionDetailScreen(
                    navigate = navigate,
                    sessionId = selectedSessionId,
                    initialSession = sessionsState.sessions
                        .asSequence()
                        .plus(sessionsState.archivedSessions.asSequence())
                        .firstOrNull { it.id == selectedSessionId },
                    devices = sessionsState.devices,
                    controller = sessionDetailController,
                    onSessionChanged = onSessionChanged,
                )
                AppDestination.DeviceDetail -> DeviceDetailScreen(
                    navigate = navigate,
                    state = sessionsState,
                    selectedDeviceId = selectedDeviceId,
                    onRenameDevice = onRenameDevice,
                    onDeleteDevice = onDeleteDevice,
                    onPrepareDeviceSetup = onPrepareDeviceSetup,
                    onClaimDevicePairCode = onClaimDevicePairCode,
                    onDeleteDeviceAgent = onDeleteDeviceAgent,
                )
                AppDestination.Devices,
                AppDestination.Profile -> Unit
            }
        }
    }
}

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun AgentsAnywhereAppPreview() {
    AgentsAnywhereTheme {
        AgentsAnywhereApp()
    }
}
