package com.agentsanywhere.app.ui.designsystem

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontFamily
import androidx.core.view.WindowCompat

object AAColor {
    val Canvas = Color(0xFFFDFCFB)
    val Ink = Color(0xFF0A0A0B)
    val InkSoft = Color(0xFF2B2B2B)
    val Muted = Color(0xFF777777)
    val Faint = Color(0xFFAAA8A2)
    val Border = Color(0xFFE7E5E0)
    val Subtle = Color(0xFFF1F0ED)
    val ToolSurface = Color(0xFFECECEA)
    val Done = Color(0xFFE4E2DD)
    val UserBubble = Color(0xFFF0EFEB)
}

data class AgentsAnywhereColors(
    val canvas: Color,
    val ink: Color,
    val inkSoft: Color,
    val muted: Color,
    val faint: Color,
    val border: Color,
    val subtle: Color,
    val raisedSurface: Color,
    val onRaisedSurface: Color,
    val primaryAction: Color,
    val onPrimaryAction: Color,
    val secondaryActionBorder: Color,
    val matchedAccountSurface: Color,
    val errorSurface: Color,
    val errorBorder: Color,
    val errorText: Color,
    val errorIcon: Color,
)

private val LightAgentsAnywhereColors = AgentsAnywhereColors(
    canvas = Color(0xFFFDFCFB),
    ink = Color(0xFF0A0A0B),
    inkSoft = Color(0xFF2B2B2B),
    muted = Color(0xFF777777),
    faint = Color(0xFFAAA8A2),
    border = Color(0xFFE7E5E0),
    subtle = Color(0xFFF1F0ED),
    raisedSurface = Color.White,
    onRaisedSurface = Color(0xFF111111),
    primaryAction = Color(0xFF0A0A0B),
    onPrimaryAction = Color.White,
    secondaryActionBorder = Color(0xFF0A0A0B),
    matchedAccountSurface = Color(0xFFF6F6F3),
    errorSurface = Color(0xFFFFF4F4),
    errorBorder = Color(0xFFF4C7C7),
    errorText = Color(0xFFB42318),
    errorIcon = Color(0xFFB42318),
)

private val DarkAgentsAnywhereColors = AgentsAnywhereColors(
    canvas = Color(0xFF09090B),
    ink = Color(0xFFFAFAFA),
    inkSoft = Color(0xFFE4E4E7),
    muted = Color(0xFFA1A1AA),
    faint = Color(0xFF71717A),
    border = Color(0xFF27272A),
    subtle = Color(0xFF18181B),
    raisedSurface = Color(0xFF18181B),
    onRaisedSurface = Color(0xFFFAFAFA),
    primaryAction = Color(0xFFFAFAFA),
    onPrimaryAction = Color(0xFF09090B),
    secondaryActionBorder = Color(0xFF27272A),
    matchedAccountSurface = Color(0xFF111113),
    errorSurface = Color(0xFF2A1214),
    errorBorder = Color(0xFF5F2429),
    errorText = Color(0xFFFCA5A5),
    errorIcon = Color(0xFFF97066),
)

val LocalAAColors = staticCompositionLocalOf { LightAgentsAnywhereColors }

private val LightAgentsAnywhereColorScheme = lightColorScheme(
    primary = AAColor.Ink,
    onPrimary = Color.White,
    background = AAColor.Canvas,
    onBackground = AAColor.Ink,
    surface = AAColor.Canvas,
    onSurface = AAColor.Ink,
    surfaceVariant = AAColor.Subtle,
    outline = AAColor.Border,
)

private val DarkAgentsAnywhereColorScheme = darkColorScheme(
    primary = DarkAgentsAnywhereColors.ink,
    onPrimary = DarkAgentsAnywhereColors.canvas,
    background = DarkAgentsAnywhereColors.canvas,
    onBackground = DarkAgentsAnywhereColors.ink,
    surface = DarkAgentsAnywhereColors.canvas,
    onSurface = DarkAgentsAnywhereColors.ink,
    surfaceVariant = DarkAgentsAnywhereColors.subtle,
    outline = DarkAgentsAnywhereColors.border,
)

private val AgentsAnywhereTypography = Typography(
    displayLarge = Typography().displayLarge.copy(fontFamily = FontFamily.SansSerif),
    headlineLarge = Typography().headlineLarge.copy(fontFamily = FontFamily.SansSerif),
    titleLarge = Typography().titleLarge.copy(fontFamily = FontFamily.SansSerif),
    bodyLarge = Typography().bodyLarge.copy(fontFamily = FontFamily.SansSerif),
    bodyMedium = Typography().bodyMedium.copy(fontFamily = FontFamily.SansSerif),
    labelLarge = Typography().labelLarge.copy(fontFamily = FontFamily.SansSerif),
)

@Composable
fun AgentsAnywhereTheme(content: @Composable () -> Unit) {
    val darkTheme = isSystemInDarkTheme()
    val colors = if (darkTheme) DarkAgentsAnywhereColors else LightAgentsAnywhereColors
    val colorScheme = if (darkTheme) DarkAgentsAnywhereColorScheme else LightAgentsAnywhereColorScheme
    val view = LocalView.current

    SideEffect {
        val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
        window.statusBarColor = colors.canvas.toArgb()
        window.navigationBarColor = colors.canvas.toArgb()
        WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        WindowCompat.getInsetsController(window, view).isAppearanceLightNavigationBars = !darkTheme
    }

    CompositionLocalProvider(LocalAAColors provides colors) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = AgentsAnywhereTypography,
            content = content,
        )
    }
}
