package com.agentsanywhere.app.ui.screens.auth

import android.content.res.Configuration
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAWordmark
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.QrCode
import com.composables.icons.lucide.Server

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
                )
                AAWordmark(color = colors.ink, fontSize = 42.sp, lineHeight = 44.sp)
                Text(
                    text = stringResource(R.string.auth_choose_login),
                    color = colors.muted,
                    fontSize = 14.sp,
                    lineHeight = 18.sp,
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                LoginMethodButton(
                    label = stringResource(R.string.auth_continue_qr),
                    icon = Lucide.QrCode,
                    onClick = { navigate(AppDestination.QrLogin) },
                )
                LoginMethodButton(
                    label = stringResource(R.string.auth_enter_server),
                    icon = Lucide.Server,
                    onClick = { navigate(AppDestination.ServerSetup) },
                )
            }
        }
    }
}

@Composable
private fun LoginMethodButton(label: String, icon: ImageVector, onClick: () -> Unit) {
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
        Icon(icon, contentDescription = null, tint = colors.onRaisedSurface, modifier = Modifier.size(22.dp))
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
        Icon(icon, contentDescription = null, tint = colors.onRaisedSurface, modifier = Modifier.size(22.dp))
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
                Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
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
    loadingLabel: String = stringResource(R.string.auth_opening_web_login),
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

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun LoginMethodsLightPreview() {
    AgentsAnywhereTheme { LoginMethodsScreen(navigate = {}) }
}

@Preview(showBackground = true, widthDp = 390, heightDp = 844, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun LoginMethodsDarkPreview() {
    AgentsAnywhereTheme { LoginMethodsScreen(navigate = {}) }
}
