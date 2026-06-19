package com.agentsanywhere.app.ui.screens.sessiondetail

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat

@Composable
internal fun FullscreenBlackSystemBars() {
    val view = LocalView.current
    val window = (view.parent as? DialogWindowProvider)?.window
        ?: view.context.findActivity()?.window
        ?: return
    val controller = WindowCompat.getInsetsController(window, view)
    val previous = remember(window, view) {
        SystemBarState(
            statusBarColor = window.statusBarColor,
            navigationBarColor = window.navigationBarColor,
            lightStatusBars = controller.isAppearanceLightStatusBars,
            lightNavigationBars = controller.isAppearanceLightNavigationBars,
        )
    }

    DisposableEffect(window, view) {
        onDispose {
            window.statusBarColor = previous.statusBarColor
            window.navigationBarColor = previous.navigationBarColor
            controller.isAppearanceLightStatusBars = previous.lightStatusBars
            controller.isAppearanceLightNavigationBars = previous.lightNavigationBars
        }
    }

    SideEffect {
        window.statusBarColor = Color.Black.toArgb()
        window.navigationBarColor = Color.Black.toArgb()
        controller.apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
    }
}

private data class SystemBarState(
    val statusBarColor: Int,
    val navigationBarColor: Int,
    val lightStatusBars: Boolean,
    val lightNavigationBars: Boolean,
)

private tailrec fun Context.findActivity(): Activity? {
    return when (this) {
        is Activity -> this
        is ContextWrapper -> baseContext.findActivity()
        else -> null
    }
}
