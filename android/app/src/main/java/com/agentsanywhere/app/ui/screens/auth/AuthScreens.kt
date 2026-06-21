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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.feature.auth.AuthController
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.auth.AuthState
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import com.agentsanywhere.app.ui.designsystem.AuthErrorNotice
import com.agentsanywhere.app.ui.designsystem.BackPill
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.composables.icons.lucide.KeyRound
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
                    text = "Continue to",
                    color = colors.ink,
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 26.sp,
                    letterSpacing = 0.sp,
                )
                Text(
                    text = "Agents Anywhere",
                    color = colors.ink,
                    fontSize = 42.sp,
                    fontFamily = FontFamily.Cursive,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 44.sp,
                    letterSpacing = 0.sp,
                )
                Text(
                    text = "Choose how you want to login.",
                    color = colors.muted,
                    fontSize = 14.sp,
                    lineHeight = 18.sp,
                    letterSpacing = 0.sp,
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                LoginMethodButton(
                    label = "Continue with Password",
                    icon = Lucide.KeyRound,
                    onClick = { navigate(AppDestination.PasswordLogin) },
                )
                LoginMethodButton(
                    label = "Continue with QR Code",
                    icon = Lucide.QrCode,
                    onClick = { navigate(AppDestination.QrLogin) },
                )
                LoginMethodButton(
                    label = "Continue with OAuth",
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
                    text = "New here?",
                    color = colors.muted,
                    fontSize = 13.sp,
                    lineHeight = 16.sp,
                )
                Text(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .noRippleClickable { navigate(AppDestination.CreateAccount) }
                        .padding(horizontal = 4.dp, vertical = 4.dp),
                    text = "Create an account",
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
            BackPill(label = "Back", onClick = navigateBack)
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text = "Sign in to",
                    color = colors.ink,
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 26.sp,
                    letterSpacing = 0.sp,
                )
                Text(
                    text = "Agents Anywhere",
                    color = colors.ink,
                    fontSize = 42.sp,
                    fontFamily = FontFamily.Cursive,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 44.sp,
                    letterSpacing = 0.sp,
                )
                Text(
                    text = "Use your User ID and password to continue.",
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
                    placeholder = "Server URL",
                    icon = Lucide.Server,
                    enabled = !state.isSubmitting,
                )
                AuthInputRow(
                    value = state.userId,
                    onValueChange = { state = state.copy(userId = it, errorMessage = null) },
                    placeholder = "User ID",
                    icon = Lucide.User,
                    enabled = !state.isSubmitting,
                )
                AuthInputRow(
                    value = state.password,
                    onValueChange = { state = state.copy(password = it, errorMessage = null) },
                    placeholder = "Password",
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
                                errorMessage = error.message ?: "Login failed.",
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
    label: String = "Continue",
    loadingLabel: String = "Signing in...",
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
    OAuthSetupScreen(navigate = navigate)
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
