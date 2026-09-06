package com.agentsanywhere.app.ui.screens.auth

import android.content.res.Configuration
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
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

            Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
                LoginMethodButton(
                    label = stringResource(R.string.auth_continue_qr),
                    icon = Lucide.QrCode,
                    primary = true,
                    onClick = { navigate(AppDestination.QrLogin) },
                )
                LoginMethodButton(
                    label = stringResource(R.string.auth_password_login),
                    primary = false,
                    onClick = { navigate(AppDestination.ServerSetup) },
                )
            }
        }
    }
}

@Composable
private fun LoginMethodButton(
    label: String,
    primary: Boolean,
    icon: ImageVector? = null,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(12.dp)
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val hovered by interactionSource.collectIsHoveredAsState()
    val focused by interactionSource.collectIsFocusedAsState()
    val highlighted = pressed || hovered || focused
    val background by animateColorAsState(
        targetValue = when {
            primary -> if (pressed) Color(0xFFD4D4D4) else Color(0xFFE5E5E5)
            highlighted -> if (colors.isDark) Color(0xFF121212) else Color(0xFFF0F0F0)
            else -> Color.Transparent
        },
        animationSpec = tween(100),
        label = "loginButtonBackground",
    )
    val foreground by animateColorAsState(
        targetValue = when {
            primary -> Color(0xFF171717)
            highlighted -> colors.ink
            else -> colors.muted
        },
        animationSpec = tween(100),
        label = "loginButtonForeground",
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .shadow(
                elevation = if (!primary && highlighted) 3.dp else 0.dp,
                shape = shape,
                ambientColor = Color.Black.copy(alpha = 0.12f),
                spotColor = Color.Black.copy(alpha = 0.12f),
            )
            .clip(shape)
            .background(background)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(horizontal = 18.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = foreground, modifier = Modifier.size(22.dp))
        }
        Text(
            modifier = Modifier.padding(start = if (icon != null) 10.dp else 0.dp),
            text = label,
            color = foreground,
            fontSize = 15.3.sp,
            fontWeight = FontWeight.Medium,
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
