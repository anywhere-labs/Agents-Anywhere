package com.agentsanywhere.app.ui.screens.auth

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.feature.auth.AuthController
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.auth.OAuthFlowState
import com.agentsanywhere.app.feature.auth.OAuthPending
import com.agentsanywhere.app.feature.auth.OAuthPendingStatus
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import com.agentsanywhere.app.ui.designsystem.AuthErrorNotice
import com.agentsanywhere.app.ui.designsystem.BackPill
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.LockKeyhole
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Server
import com.composables.icons.lucide.User
import kotlinx.coroutines.launch

private const val RegistrationClosedMessage = "OAuth registration is closed. Contact your administrator to enable it."

@Composable
fun OAuthSetupScreen(
    navigate: (AppDestination) -> Unit,
    errorMessage: String? = null,
    onErrorConsumed: () -> Unit = {},
) {
    val colors = LocalAAColors.current
    val context = LocalContext.current
    val authController = remember(context) {
        AuthController(
            api = AuthApi(),
            sessionStore = AuthSessionStore(context),
        )
    }
    val scope = rememberCoroutineScope()
    var state by remember(authController) {
        mutableStateOf(
            OAuthSetupUiState(
                serverUrl = authController.savedServerUrl(),
                errorMessage = errorMessage,
            ),
        )
    }
    val navigateBack = { navigate(AppDestination.LoginMethods) }

    BackHandler { navigateBack() }

    LaunchedEffect(errorMessage) {
        if (!errorMessage.isNullOrBlank()) {
            state = state.copy(errorMessage = errorMessage)
            onErrorConsumed()
        }
    }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 74.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(30.dp),
        ) {
            BackPill(label = "Back", onClick = navigateBack)
            Text(
                text = "Enter your server URL first",
                color = colors.ink,
                fontSize = 24.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 26.sp,
                letterSpacing = 0.sp,
            )
            state.errorMessage?.let { message ->
                AuthErrorNotice(message = message)
            }
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                AuthInputRow(
                    value = state.serverUrl,
                    onValueChange = { state = state.copy(serverUrl = it, errorMessage = null) },
                    placeholder = "Server URL",
                    icon = Lucide.Server,
                    enabled = !state.isSubmitting,
                )
                AuthContinueButton(
                    isLoading = state.isSubmitting,
                    loadingLabel = "Opening OAuth...",
                ) {
                    val submitted = state.serverUrl
                    state = state.copy(isSubmitting = true, errorMessage = null)
                    scope.launch {
                        authController.startOAuth(
                            serverUrl = submitted,
                            returnTo = AuthController.OAUTH_CALLBACK_URI,
                        ).onSuccess { authorizeUrl ->
                            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(authorizeUrl))
                            runCatching { context.startActivity(intent) }
                                .onFailure { error ->
                                    val message = if (error is ActivityNotFoundException) {
                                        "No browser app is available to continue OAuth sign-in."
                                    } else {
                                        error.message ?: "Could not open OAuth sign-in."
                                    }
                                    state = state.copy(isSubmitting = false, errorMessage = message)
                                }
                            if (state.errorMessage == null) {
                                state = state.copy(isSubmitting = false)
                            }
                        }.onFailure { error ->
                            state = state.copy(
                                isSubmitting = false,
                                errorMessage = error.message ?: "OAuth sign-in failed.",
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun OAuthLinkExistingAccountScreen(
    navigate: (AppDestination) -> Unit,
    flowState: OAuthFlowState?,
) {
    val colors = LocalAAColors.current
    val context = LocalContext.current
    val authController = remember(context) {
        AuthController(
            api = AuthApi(),
            sessionStore = AuthSessionStore(context),
        )
    }
    val scope = rememberCoroutineScope()
    var password by remember(flowState) { mutableStateOf("") }
    var isSubmitting by remember(flowState) { mutableStateOf(false) }
    var errorMessage by remember(flowState) { mutableStateOf<String?>(null) }
    val navigateBack = { navigate(AppDestination.OAuthSetup) }

    BackHandler { navigateBack() }

    if (flowState == null) {
        OAuthMissingSessionScreen(navigate)
        return
    }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 74.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(30.dp),
        ) {
            BackPill(label = "Back", onClick = navigateBack)
            OAuthPageHeader(
                title = "Is this your account?",
                subtitle = "OAuth matched an existing local account. Enter its password to link and sign in.",
            )
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                MatchedAccountCard(userId = flowState.pending.suggestedUserId)
                errorMessage?.let { message ->
                    AuthErrorNotice(message = message)
                }
                AuthInputRow(
                    value = password,
                    onValueChange = {
                        password = it
                        errorMessage = null
                    },
                    placeholder = "Password",
                    icon = Lucide.LockKeyhole,
                    isPassword = true,
                    enabled = !isSubmitting,
                )
                Spacer(Modifier.height(10.dp))
                AuthContinueButton(
                    isLoading = isSubmitting,
                    label = "Link and sign in",
                    loadingLabel = "Linking...",
                ) {
                    isSubmitting = true
                    errorMessage = null
                    scope.launch {
                        authController.finalizeBoundOAuth(
                            serverUrl = flowState.serverUrl,
                            pendingToken = flowState.pending.pendingToken,
                            userId = flowState.pending.suggestedUserId,
                            password = password,
                        ).onSuccess {
                            isSubmitting = false
                            navigate(AppDestination.Sessions)
                        }.onFailure { error ->
                            isSubmitting = false
                            errorMessage = error.message ?: "OAuth sign-in failed."
                        }
                    }
                }
                OAuthSecondaryButton(
                    label = "Use another account",
                    enabled = !isSubmitting,
                ) {
                    isSubmitting = true
                    errorMessage = null
                    scope.launch {
                        authController.authConfig(flowState.serverUrl)
                            .onSuccess { config ->
                                isSubmitting = false
                                navigate(
                                    if (config.oauthRegistrationOpen) {
                                        AppDestination.OAuthCreateAccount
                                    } else {
                                        AppDestination.OAuthRegistrationClosed
                                    },
                                )
                            }
                            .onFailure { error ->
                                isSubmitting = false
                                errorMessage = error.message ?: "Could not check auth configuration."
                            }
                    }
                }
            }
        }
    }
}

@Composable
fun OAuthRegistrationClosedScreen(navigate: (AppDestination) -> Unit) {
    val navigateBack = { navigate(AppDestination.OAuthSetup) }

    BackHandler { navigateBack() }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 74.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(30.dp),
        ) {
            BackPill(label = "Back", onClick = navigateBack)
            OAuthPageHeader(title = "Registration is closed")
            AuthErrorNotice(message = RegistrationClosedMessage)
            AuthContinueButton(
                isLoading = false,
                label = "Back to sign in",
            ) {
                navigate(AppDestination.LoginMethods)
            }
        }
    }
}

@Composable
fun OAuthCreateAccountScreen(
    navigate: (AppDestination) -> Unit,
    flowState: OAuthFlowState?,
    onOAuthPendingReceived: (OAuthFlowState, AppDestination) -> Unit,
) {
    OAuthCreateAccountFormScreen(
        navigate = navigate,
        flowState = flowState,
        initialErrorMessage = null,
        onRegistrationClosed = { flow ->
            onOAuthPendingReceived(flow, AppDestination.OAuthRegistrationClosedError)
        },
    )
}

@Composable
fun OAuthRegistrationClosedErrorScreen(
    navigate: (AppDestination) -> Unit,
    flowState: OAuthFlowState?,
) {
    OAuthCreateAccountFormScreen(
        navigate = navigate,
        flowState = flowState,
        initialErrorMessage = RegistrationClosedMessage,
        onRegistrationClosed = {},
    )
}

@Composable
private fun OAuthCreateAccountFormScreen(
    navigate: (AppDestination) -> Unit,
    flowState: OAuthFlowState?,
    initialErrorMessage: String?,
    onRegistrationClosed: (OAuthFlowState) -> Unit,
) {
    val context = LocalContext.current
    val authController = remember(context) {
        AuthController(
            api = AuthApi(),
            sessionStore = AuthSessionStore(context),
        )
    }
    val scope = rememberCoroutineScope()
    var userId by remember(flowState) { mutableStateOf(flowState?.pending?.suggestedUserId.orEmpty()) }
    var password by remember(flowState) { mutableStateOf("") }
    var confirmPassword by remember(flowState) { mutableStateOf("") }
    var isSubmitting by remember(flowState) { mutableStateOf(false) }
    var errorMessage by remember(flowState, initialErrorMessage) { mutableStateOf(initialErrorMessage) }
    val navigateBack = { navigate(AppDestination.OAuthSetup) }

    BackHandler { navigateBack() }

    if (flowState == null) {
        OAuthMissingSessionScreen(navigate)
        return
    }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 74.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(30.dp),
        ) {
            BackPill(label = "Back", onClick = navigateBack)
            OAuthPageHeader(
                title = "Create your account",
                subtitle = "Confirm your user ID and set a password to finish OAuth sign-up.",
            )
            errorMessage?.let { message ->
                AuthErrorNotice(message = message)
            }
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                AuthInputRow(
                    value = userId,
                    onValueChange = {
                        userId = it.replace("\\s".toRegex(), "")
                        errorMessage = null
                    },
                    placeholder = "User ID",
                    icon = Lucide.User,
                    enabled = !isSubmitting,
                )
                AuthInputRow(
                    value = password,
                    onValueChange = {
                        password = it
                        errorMessage = null
                    },
                    placeholder = "Password",
                    icon = Lucide.LockKeyhole,
                    isPassword = true,
                    enabled = !isSubmitting,
                )
                AuthInputRow(
                    value = confirmPassword,
                    onValueChange = {
                        confirmPassword = it
                        errorMessage = null
                    },
                    placeholder = "Confirm password",
                    icon = Lucide.LockKeyhole,
                    isPassword = true,
                    enabled = !isSubmitting,
                )
                AuthContinueButton(
                    isLoading = isSubmitting,
                    label = "Create and sign in",
                    loadingLabel = "Creating...",
                ) {
                    val trimmedUserId = userId.trim()
                    when {
                        trimmedUserId.isBlank() -> errorMessage = "Enter your User ID."
                        password.isBlank() -> errorMessage = "Enter your password."
                        password != confirmPassword -> errorMessage = "Passwords do not match."
                        else -> {
                            isSubmitting = true
                            errorMessage = null
                            scope.launch {
                                authController.finalizeNewOAuthAccount(
                                    serverUrl = flowState.serverUrl,
                                    pendingToken = flowState.pending.pendingToken,
                                    userId = trimmedUserId,
                                    password = password,
                                ).onSuccess {
                                    isSubmitting = false
                                    navigate(AppDestination.Sessions)
                                }.onFailure { error ->
                                    isSubmitting = false
                                    if ((error as? ApiException)?.statusCode == 403) {
                                        onRegistrationClosed(flowState)
                                        errorMessage = RegistrationClosedMessage
                                    } else {
                                        errorMessage = error.message ?: "OAuth sign-in failed."
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun OAuthMissingSessionScreen(navigate: (AppDestination) -> Unit) {
    val navigateBack = { navigate(AppDestination.OAuthSetup) }

    BackHandler { navigateBack() }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 74.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(30.dp),
        ) {
            BackPill(label = "Back", onClick = navigateBack)
            OAuthPageHeader(title = "OAuth session expired")
            AuthErrorNotice(message = "Start OAuth sign-in again.")
            AuthContinueButton(
                isLoading = false,
                label = "Back to sign in",
            ) {
                navigate(AppDestination.LoginMethods)
            }
        }
    }
}

@Composable
private fun OAuthPageHeader(
    title: String,
    subtitle: String? = null,
) {
    val colors = LocalAAColors.current

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = title,
            color = colors.ink,
            fontSize = 25.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 27.sp,
            letterSpacing = 0.sp,
        )
        if (!subtitle.isNullOrBlank()) {
            Text(
                text = subtitle,
                color = colors.muted,
                fontSize = 14.5.sp,
                lineHeight = 19.sp,
                letterSpacing = 0.sp,
            )
        }
    }
}

@Composable
private fun MatchedAccountCard(userId: String) {
    val colors = LocalAAColors.current
    val initial = userId.firstOrNull()?.uppercaseChar()?.toString().orEmpty().ifBlank { "A" }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(colors.matchedAccountSurface)
            .border(1.2.dp, colors.border, RoundedCornerShape(22.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "Matched profile",
                color = colors.muted,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 15.sp,
            )
            OAuthVerifiedPill()
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(46.dp)
                    .clip(CircleShape)
                    .background(colors.ink),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = initial,
                    color = colors.canvas,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 22.sp,
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    text = userId,
                    color = colors.ink,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 21.sp,
                )
                Text(
                    text = "Existing local account found",
                    color = colors.muted,
                    fontSize = 13.sp,
                    lineHeight = 16.sp,
                )
            }
        }
    }
}

@Composable
private fun OAuthVerifiedPill() {
    val colors = LocalAAColors.current

    Row(
        modifier = Modifier
            .clip(CircleShape)
            .background(colors.raisedSurface)
            .border(1.dp, colors.border, CircleShape)
            .padding(horizontal = 9.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.Icon(
            imageVector = Lucide.Check,
            contentDescription = null,
            tint = colors.onRaisedSurface,
            modifier = Modifier.size(12.dp),
        )
        Text(
            text = "OAuth",
            color = colors.onRaisedSurface,
            fontSize = 11.5.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 13.sp,
        )
    }
}

@Composable
private fun OAuthSecondaryButton(
    label: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(62.dp)
            .clip(RoundedCornerShape(17.dp))
            .background(colors.raisedSurface)
            .border(1.2.dp, colors.secondaryActionBorder, RoundedCornerShape(17.dp))
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = colors.onRaisedSurface,
            fontSize = 15.3.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 18.sp,
            textAlign = TextAlign.Center,
        )
    }
}

private data class OAuthSetupUiState(
    val serverUrl: String = "",
    val isSubmitting: Boolean = false,
    val errorMessage: String? = null,
)

@Preview(name = "OAuth Setup Light", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun OAuthSetupLightPreview() {
    AgentsAnywhereTheme {
        OAuthSetupScreen(navigate = {})
    }
}

@Preview(
    name = "OAuth Setup Dark",
    showBackground = true,
    widthDp = 390,
    heightDp = 844,
    uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES,
)
@Composable
private fun OAuthSetupDarkPreview() {
    AgentsAnywhereTheme {
        OAuthSetupScreen(navigate = {})
    }
}

@Preview(name = "OAuth Link Light", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun OAuthLinkLightPreview() {
    AgentsAnywhereTheme {
        OAuthLinkExistingAccountScreen(
            navigate = {},
            flowState = previewOAuthFlow(),
        )
    }
}

@Preview(
    name = "OAuth Link Dark",
    showBackground = true,
    widthDp = 390,
    heightDp = 844,
    uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES,
)
@Composable
private fun OAuthLinkDarkPreview() {
    AgentsAnywhereTheme {
        OAuthLinkExistingAccountScreen(
            navigate = {},
            flowState = previewOAuthFlow(),
        )
    }
}

@Preview(name = "OAuth Create Light", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun OAuthCreateLightPreview() {
    AgentsAnywhereTheme {
        OAuthCreateAccountScreen(
            navigate = {},
            flowState = previewOAuthFlow(status = OAuthPendingStatus.NeedsRegistration),
            onOAuthPendingReceived = { _, _ -> },
        )
    }
}

@Preview(
    name = "OAuth Create Dark",
    showBackground = true,
    widthDp = 390,
    heightDp = 844,
    uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES,
)
@Composable
private fun OAuthCreateDarkPreview() {
    AgentsAnywhereTheme {
        OAuthCreateAccountScreen(
            navigate = {},
            flowState = previewOAuthFlow(status = OAuthPendingStatus.NeedsRegistration),
            onOAuthPendingReceived = { _, _ -> },
        )
    }
}

private fun previewOAuthFlow(
    status: OAuthPendingStatus = OAuthPendingStatus.NeedsPassword,
) = OAuthFlowState(
    serverUrl = "http://192.168.1.10:8000",
    pending = OAuthPending(
        status = status,
        pendingToken = "preview",
        suggestedUserId = "benson",
    ),
)
