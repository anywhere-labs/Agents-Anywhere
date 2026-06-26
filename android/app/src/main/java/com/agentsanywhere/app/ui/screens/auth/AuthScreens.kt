package com.agentsanywhere.app.ui.screens.auth

import android.content.res.Configuration
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.feature.auth.AuthController
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.auth.AuthState
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAWordmark
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import com.agentsanywhere.app.ui.designsystem.AuthErrorNotice
import com.agentsanywhere.app.ui.designsystem.BackPill
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.LockKeyhole
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.QrCode
import com.composables.icons.lucide.Server
import com.composables.icons.lucide.ShieldCheck
import com.composables.icons.lucide.User
import kotlinx.coroutines.launch

@Composable
fun LoginMethodsScreen(navigate: (AppDestination) -> Unit) {
    val colors = LocalAAColors.current

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 104.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(30.dp),
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text = stringResource(R.string.auth_continue_to),
                    color = colors.ink,
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 26.sp,
                    letterSpacing = 0.sp,
                )
                AAWordmark(
                    color = colors.ink,
                    fontSize = 42.sp,
                    lineHeight = 44.sp,
                )
                Text(
                    text = stringResource(R.string.auth_choose_login),
                    color = colors.muted,
                    fontSize = 14.sp,
                    lineHeight = 18.sp,
                    letterSpacing = 0.sp,
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                LoginMethodButton(
                    label = stringResource(R.string.auth_continue_password),
                    icon = Lucide.KeyRound,
                    onClick = { navigate(AppDestination.PasswordLogin) },
                )
                LoginMethodButton(
                    label = stringResource(R.string.auth_continue_qr),
                    icon = Lucide.QrCode,
                    onClick = { navigate(AppDestination.QrLogin) },
                )
                LoginMethodButton(
                    label = stringResource(R.string.auth_continue_oauth),
                    icon = Lucide.ShieldCheck,
                    onClick = { navigate(AppDestination.OAuthSetup) },
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.auth_new_here),
                    color = colors.muted,
                    fontSize = 13.sp,
                    lineHeight = 16.sp,
                )
                Text(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .noRippleClickable { navigate(AppDestination.CreateAccount) }
                        .padding(horizontal = 4.dp, vertical = 4.dp),
                    text = stringResource(R.string.auth_create_account_link),
                    color = colors.ink,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 16.sp,
                )
            }
        }
    }
}

@Composable
private fun LoginMethodButton(
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(62.dp)
            .clip(RoundedCornerShape(17.dp))
            .background(colors.raisedSurface)
            .border(1.2.dp, colors.border, RoundedCornerShape(17.dp))
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 18.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(22.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = colors.onRaisedSurface,
                modifier = Modifier.size(22.dp),
            )
        }
        Text(
            modifier = Modifier.padding(start = 10.dp),
            text = label,
            color = colors.onRaisedSurface,
            fontSize = 15.3.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 18.sp,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
fun PasswordLoginScreen(navigate: (AppDestination) -> Unit) {
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
        mutableStateOf(AuthState(serverUrl = authController.savedServerUrl()))
    }
    val navigateBack = { navigate(AppDestination.LoginMethods) }

    BackHandler {
        navigateBack()
    }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 74.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(30.dp),
        ) {
            BackPill(label = stringResource(R.string.common_back), onClick = navigateBack)
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text = stringResource(R.string.auth_sign_in_to),
                    color = colors.ink,
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 26.sp,
                    letterSpacing = 0.sp,
                )
                AAWordmark(
                    color = colors.ink,
                    fontSize = 42.sp,
                    lineHeight = 44.sp,
                )
                Text(
                    text = stringResource(R.string.auth_password_subtitle),
                    color = colors.muted,
                    fontSize = 14.sp,
                    lineHeight = 18.sp,
                    letterSpacing = 0.sp,
                )
            }
            state.errorMessage?.let { message ->
                AuthErrorNotice(message = message)
            }
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                AuthInputRow(
                    value = state.serverUrl,
                    onValueChange = { state = state.copy(serverUrl = it, errorMessage = null) },
                    placeholder = stringResource(R.string.common_server_url),
                    icon = Lucide.Server,
                    enabled = !state.isSubmitting,
                )
                AuthInputRow(
                    value = state.userId,
                    onValueChange = { state = state.copy(userId = it, errorMessage = null) },
                    placeholder = stringResource(R.string.common_user_id),
                    icon = Lucide.User,
                    enabled = !state.isSubmitting,
                )
                AuthInputRow(
                    value = state.password,
                    onValueChange = { state = state.copy(password = it, errorMessage = null) },
                    placeholder = stringResource(R.string.common_password),
                    icon = Lucide.KeyRound,
                    isPassword = true,
                    enabled = !state.isSubmitting,
                )
                AuthContinueButton(isLoading = state.isSubmitting) {
                    val submittedState = state
                    state = state.copy(isSubmitting = true, errorMessage = null)
                    scope.launch {
                        authController.loginWithPassword(
                            serverUrl = submittedState.serverUrl,
                            userId = submittedState.userId,
                            password = submittedState.password,
                        ).onSuccess {
                            state = state.copy(isSubmitting = false, password = "")
                            navigate(AppDestination.Sessions)
                        }.onFailure { error ->
                            state = state.copy(
                                isSubmitting = false,
                                errorMessage = error.message ?: context.getString(R.string.auth_login_failed),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun AuthInputRow(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    icon: ImageVector,
    isPassword: Boolean = false,
    enabled: Boolean = true,
) {
    val colors = LocalAAColors.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(62.dp)
            .clip(RoundedCornerShape(17.dp))
            .background(colors.raisedSurface)
            .border(1.2.dp, colors.border, RoundedCornerShape(17.dp))
            .padding(horizontal = 18.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(22.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = colors.onRaisedSurface,
                modifier = Modifier.size(22.dp),
            )
        }
        androidx.compose.foundation.text.BasicTextField(
            modifier = Modifier.weight(1f),
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true,
            textStyle = androidx.compose.ui.text.TextStyle(
                color = colors.ink,
                fontSize = 15.3.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 18.sp,
            ),
            cursorBrush = SolidColor(colors.ink),
            visualTransformation = if (isPassword) {
                androidx.compose.ui.text.input.PasswordVisualTransformation()
            } else {
                androidx.compose.ui.text.input.VisualTransformation.None
            },
            decorationBox = { innerTextField ->
                Box(
                    modifier = Modifier.fillMaxWidth(),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (value.isEmpty()) {
                        Text(
                            text = placeholder,
                            color = colors.muted,
                            fontSize = 15.3.sp,
                            fontWeight = FontWeight.Medium,
                            lineHeight = 18.sp,
                        )
                    }
                    innerTextField()
                }
            },
        )
    }
}

@Composable
internal fun AuthContinueButton(
    isLoading: Boolean,
    label: String = stringResource(R.string.common_continue),
    loadingLabel: String = stringResource(R.string.auth_signing_in),
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(62.dp)
            .clip(RoundedCornerShape(17.dp))
            .background(colors.primaryAction)
            .noRippleClickable(enabled = !isLoading, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (isLoading) loadingLabel else label,
            color = colors.onPrimaryAction,
            fontSize = 15.3.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 18.sp,
        )
    }
}

@Composable
fun CreateAccountScreen(navigate: (AppDestination) -> Unit) {
    val colors = LocalAAColors.current
    val context = LocalContext.current
    val authController = remember(context) {
        AuthController(
            api = AuthApi(),
            sessionStore = AuthSessionStore(context),
        )
    }
    val scope = rememberCoroutineScope()
    var serverUrl by remember(authController) { mutableStateOf(authController.savedServerUrl()) }
    var userId by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var isChecking by remember { mutableStateOf(false) }
    var isSubmitting by remember { mutableStateOf(false) }
    var canRegister by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val navigateBack = {
        if (canRegister) {
            canRegister = false
            errorMessage = null
        } else {
            navigate(AppDestination.LoginMethods)
        }
    }

    BackHandler { navigateBack() }

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 74.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(30.dp),
        ) {
            BackPill(label = stringResource(R.string.common_back), onClick = navigateBack)
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = if (canRegister) stringResource(R.string.auth_create_your_account) else stringResource(R.string.auth_create_account),
                    color = colors.ink,
                    fontSize = 25.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 27.sp,
                    letterSpacing = 0.sp,
                )
                Text(
                    text = if (canRegister) stringResource(R.string.auth_create_your_account_subtitle) else stringResource(R.string.auth_create_account_subtitle),
                    color = colors.muted,
                    fontSize = 14.5.sp,
                    lineHeight = 19.sp,
                    letterSpacing = 0.sp,
                )
            }
            errorMessage?.let { message ->
                AuthErrorNotice(message = message)
            }
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                AuthInputRow(
                    value = serverUrl,
                    onValueChange = {
                        serverUrl = it
                        canRegister = false
                        errorMessage = null
                    },
                    placeholder = stringResource(R.string.common_server_url),
                    icon = Lucide.Server,
                    enabled = !isChecking && !isSubmitting,
                )
                if (canRegister) {
                    AuthInputRow(
                        value = userId,
                        onValueChange = {
                            userId = it.replace(Regex("[^A-Za-z0-9_-]"), "").lowercase()
                            errorMessage = null
                        },
                        placeholder = stringResource(R.string.common_user_id),
                        icon = Lucide.User,
                        enabled = !isSubmitting,
                    )
                    AuthInputRow(
                        value = password,
                        onValueChange = {
                            password = it
                            errorMessage = null
                        },
                        placeholder = stringResource(R.string.common_password),
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
                        placeholder = stringResource(R.string.auth_confirm_password),
                        icon = Lucide.LockKeyhole,
                        isPassword = true,
                        enabled = !isSubmitting,
                    )
                    AuthContinueButton(
                        isLoading = isSubmitting,
                        label = stringResource(R.string.auth_create_and_sign_in),
                        loadingLabel = stringResource(R.string.common_creating),
                    ) {
                        when {
                            password != confirmPassword -> errorMessage = context.getString(R.string.auth_passwords_do_not_match)
                            else -> {
                                isSubmitting = true
                                errorMessage = null
                                scope.launch {
                                    authController.registerWithPassword(
                                        serverUrl = serverUrl,
                                        userId = userId,
                                        password = password,
                                    ).onSuccess {
                                        isSubmitting = false
                                        navigate(AppDestination.Sessions)
                                    }.onFailure { error ->
                                        isSubmitting = false
                                        errorMessage = error.message ?: context.getString(R.string.auth_registration_failed)
                                    }
                                }
                            }
                        }
                    }
                } else {
                    AuthContinueButton(
                        isLoading = isChecking,
                        label = stringResource(R.string.auth_check_registration),
                        loadingLabel = stringResource(R.string.common_checking),
                    ) {
                        isChecking = true
                        errorMessage = null
                        scope.launch {
                            authController.authConfig(serverUrl)
                                .onSuccess { config ->
                                    isChecking = false
                                    canRegister = config.registrationOpen
                                    if (!config.registrationOpen) {
                                        errorMessage = context.getString(R.string.auth_registration_closed)
                                    }
                                }
                                .onFailure { error ->
                                    isChecking = false
                                    errorMessage = error.message ?: context.getString(R.string.auth_config_check_failed)
                                }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ServerSetupScreen(navigate: (AppDestination) -> Unit) {
    OAuthSetupScreen(navigate = navigate)
}

@Preview(name = "Login Methods Light", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun LoginMethodsLightPreview() {
    AgentsAnywhereTheme {
        LoginMethodsScreen(navigate = {})
    }
}

@Preview(
    name = "Login Methods Dark",
    showBackground = true,
    widthDp = 390,
    heightDp = 844,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
)
@Composable
private fun LoginMethodsDarkPreview() {
    AgentsAnywhereTheme {
        LoginMethodsScreen(navigate = {})
    }
}

@Preview(name = "Password Login Light", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun PasswordLoginLightPreview() {
    AgentsAnywhereTheme {
        PasswordLoginScreen(navigate = {})
    }
}

@Preview(
    name = "Password Login Dark",
    showBackground = true,
    widthDp = 390,
    heightDp = 844,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
)
@Composable
private fun PasswordLoginDarkPreview() {
    AgentsAnywhereTheme {
        PasswordLoginScreen(navigate = {})
    }
}
