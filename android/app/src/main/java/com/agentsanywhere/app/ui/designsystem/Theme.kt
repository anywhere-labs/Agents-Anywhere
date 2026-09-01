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
    val isDark: Boolean,
    val canvas: Color,
    val ink: Color,
    val inkSoft: Color,
    val muted: Color,
    val faint: Color,
    val border: Color,
    val subtle: Color,
    val raisedSurface: Color,
    val dialogSurface: Color,
    val onRaisedSurface: Color,
    val primaryAction: Color,
    val onPrimaryAction: Color,
    val secondaryActionSurface: Color,
    val secondaryActionBorder: Color,
    val matchedAccountSurface: Color,
    val errorSurface: Color,
    val errorBorder: Color,
    val errorText: Color,
    val errorIcon: Color,
    val runtimeRunning: Color,
    val runtimeTransitioning: Color,
    val runtimeActive: Color,
    val runtimeInactive: Color,
    val runtimeSwitchCheckedTrack: Color,
    val runtimeSwitchUncheckedTrack: Color,
    val runtimeSwitchCheckedThumb: Color,
    val runtimeSwitchUncheckedThumb: Color,
    val sessionStatusAccent: Color,
    val sessionStatusAccentText: Color,
    val noticeWarning: Color,
    val noticeSuccess: Color,
    val sessionMessageBubble: Color,
    val sessionMessageText: Color,
    val sessionTimelineActivitySurface: Color,
    val sessionCodeSurface: Color,
    val sessionStatusNeutralSurface: Color,
    val sessionStatusNeutralText: Color,
    val appShadow: Color,
)

private val LightAgentsAnywhereColors = AgentsAnywhereColors(
    isDark = false,
    canvas = Color(0xFFFDFCFB),
    ink = Color(0xFF0A0A0B),
    inkSoft = Color(0xFF2B2B2B),
    muted = Color(0xFF777777),
    faint = Color(0xFFAAA8A2),
    border = Color(0xFFE7E5E0),
    subtle = Color(0xFFF1F0ED),
    raisedSurface = Color.White,
    dialogSurface = Color.White,
    onRaisedSurface = Color(0xFF111111),
    primaryAction = Color(0xFF0A0A0B),
    onPrimaryAction = Color.White,
    secondaryActionSurface = Color(0xFFF3F3F3),
    secondaryActionBorder = Color(0xFF0A0A0B),
    matchedAccountSurface = Color(0xFFF6F6F3),
    errorSurface = Color(0xFFFFF4F4),
    errorBorder = Color(0xFFF4C7C7),
    errorText = Color(0xFFB42318),
    errorIcon = Color(0xFFB42318),
    runtimeRunning = Color(0xFF10B981),
    runtimeTransitioning = Color(0xFF3B82F6),
    runtimeActive = Color(0xFFF59E0B),
    runtimeInactive = Color(0x66777777),
    runtimeSwitchCheckedTrack = Color(0xFF171717),
    runtimeSwitchUncheckedTrack = Color(0xFFE5E5E5),
    runtimeSwitchCheckedThumb = Color.White,
    runtimeSwitchUncheckedThumb = Color.White,
    sessionStatusAccent = Color(0xFF22C55E),
    sessionStatusAccentText = Color(0xFF15803D),
    noticeWarning = Color(0xFFD97706),
    noticeSuccess = Color(0xFF16A34A),
    sessionMessageBubble = Color(0xFFF1F0ED),
    sessionMessageText = Color(0xFF242522),
    sessionTimelineActivitySurface = Color(0x14F1F0ED),
    sessionCodeSurface = Color(0xB8FFFFFF),
    sessionStatusNeutralSurface = Color(0xFFE4E2DD),
    sessionStatusNeutralText = Color(0xFF6F6E69),
    appShadow = Color(0x22000000),
)

private val DarkAgentsAnywhereColors = AgentsAnywhereColors(
    isDark = true,
    canvas = Color(0xFF09090B),
    ink = Color(0xFFFAFAFA),
    inkSoft = Color(0xFFE5E5E5),
    muted = Color(0xFFA3A3A3),
    faint = Color(0xFF737373),
    border = Color.Transparent,
    subtle = Color(0xFF292929),
    raisedSurface = Color(0xFF1F1F1F),
    dialogSurface = Color(0xFF242424),
    onRaisedSurface = Color(0xFFFAFAFA),
    primaryAction = Color(0xFFFAFAFA),
    onPrimaryAction = Color(0xFF09090B),
    secondaryActionSurface = Color(0xFF424242),
    secondaryActionBorder = Color.Transparent,
    matchedAccountSurface = Color(0xFF191919),
    errorSurface = Color(0xFF2A1214),
    errorBorder = Color(0xFF5F2429),
    errorText = Color(0xFFFCA5A5),
    errorIcon = Color(0xFFF97066),
    runtimeRunning = Color(0xFF10B981),
    runtimeTransitioning = Color(0xFF3B82F6),
    runtimeActive = Color(0xFFF59E0B),
    runtimeInactive = Color(0x66A1A1AA),
    runtimeSwitchCheckedTrack = Color(0xFFE5E5E5),
    runtimeSwitchUncheckedTrack = Color(0x26FFFFFF),
    runtimeSwitchCheckedThumb = Color(0xFF171717),
    runtimeSwitchUncheckedThumb = Color(0xFFFAFAFA),
    sessionStatusAccent = Color(0xFF22C55E),
    sessionStatusAccentText = Color(0xFF4ADE80),
    noticeWarning = Color(0xFFF59E0B),
    noticeSuccess = Color(0xFF22C55E),
    sessionMessageBubble = Color(0xFF2A2A2A),
    sessionMessageText = Color(0xFFF4F4F5),
    sessionTimelineActivitySurface = Color(0x1018181B),
    sessionCodeSurface = Color(0xFF111113),
    sessionStatusNeutralSurface = Color(0xFF2D2D2D),
    sessionStatusNeutralText = Color(0xFFD4D4D8),
    appShadow = Color(0x52000000),
)

val LocalAAColors = staticCompositionLocalOf { LightAgentsAnywhereColors }

object AAAppearanceMode {
    const val System = "system"
    const val Light = "light"
    const val Dark = "dark"
}

object AALanguageMode {
    const val System = "system"
    const val English = "en"
    const val SimplifiedChinese = "zh-CN"
}

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
fun AgentsAnywhereTheme(
    appearanceMode: String = AAAppearanceMode.System,
    content: @Composable () -> Unit,
) {
    val systemDarkTheme = isSystemInDarkTheme()
    val darkTheme = when (appearanceMode) {
        AAAppearanceMode.Light -> false
        AAAppearanceMode.Dark -> true
        else -> systemDarkTheme
    }
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
