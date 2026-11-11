package com.agentsanywhere.app.app

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Lucide

internal fun workspaceSidebarWidth(availableWidthDp: Float): Float? =
    if (availableWidthDp < 600f) null else (availableWidthDp * 0.36f).coerceIn(240f, 320f)

@Composable
internal fun SessionWorkspace(
    showDetail: Boolean,
    detailKey: String?,
    stateHolder: SaveableStateHolder,
    sidebarCollapsed: Boolean,
    onSidebarCollapsedChange: (Boolean) -> Unit,
    home: @Composable (compact: Boolean, onCollapse: (() -> Unit)?) -> Unit,
    detail: @Composable () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    BoxWithConstraints(modifier.fillMaxSize()) {
        val sidebarWidth = workspaceSidebarWidth(maxWidth.value)
        val wide = sidebarWidth != null
        val showHome = if (wide) !sidebarCollapsed else !showDetail
        val homeWidth = when {
            !showHome -> 0.dp
            wide -> sidebarWidth!!.dp
            else -> maxWidth
        }
        Row(Modifier.fillMaxSize()) {
            Box(Modifier.width(if (wide && sidebarCollapsed) 48.dp else 0.dp).fillMaxHeight()) {
                if (wide && sidebarCollapsed) {
                    IconButton(
                        onClick = { onSidebarCollapsedChange(false) },
                        modifier = Modifier.statusBarsPadding().size(48.dp),
                    ) {
                        Icon(
                            imageVector = Lucide.ChevronRight,
                            contentDescription = stringResource(R.string.workspace_expand_sidebar),
                            tint = colors.ink,
                        )
                    }
                }
            }
            Box(Modifier.width(homeWidth).fillMaxHeight()) {
                if (showHome) {
                    stateHolder.SaveableStateProvider("home") {
                        home(wide, if (wide) ({ onSidebarCollapsedChange(true) }) else null)
                    }
                }
            }
            // Keep this slot in place: resizing/collapsing must not remount a detail subscription.
            Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.Center) {
                if (showDetail) {
                    key(detailKey) {
                        stateHolder.SaveableStateProvider(detailKey ?: "session:empty") { detail() }
                    }
                } else if (wide) {
                    Text(
                        text = stringResource(R.string.session_open_from_list),
                        color = colors.muted,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(24.dp),
                    )
                }
            }
        }
    }
}
