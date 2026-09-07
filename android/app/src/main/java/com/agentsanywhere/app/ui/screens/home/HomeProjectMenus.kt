package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.ProjectSessionStatusFilter
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide
import kotlin.math.roundToInt

@Composable
internal fun HomeProjectAnchoredPopup(
    anchorBounds: Rect,
    onDismiss: () -> Unit,
    content: @Composable () -> Unit,
) {
    val density = LocalDensity.current
    val gap = with(density) { 6.dp.roundToPx() }
    val margin = with(density) { 12.dp.roundToPx() }
    val position = remember(anchorBounds, gap, margin) {
        object : PopupPositionProvider {
            override fun calculatePosition(
                anchorBounds: IntRect,
                windowSize: IntSize,
                layoutDirection: LayoutDirection,
                popupContentSize: IntSize,
            ): IntOffset = menuOffset(windowSize, popupContentSize)

            // The button supplies boundsInWindow, matching the popup's coordinate space.
            private fun menuOffset(windowSize: IntSize, size: IntSize): IntOffset {
                val x = (anchorBounds.right.roundToInt() - size.width)
                    .coerceIn(margin, (windowSize.width - size.width - margin).coerceAtLeast(margin))
                val below = anchorBounds.bottom.roundToInt() + gap
                val y = if (below + size.height + margin <= windowSize.height) below
                    else anchorBounds.top.roundToInt() - size.height - gap
                return IntOffset(x, y.coerceIn(margin, (windowSize.height - size.height - margin).coerceAtLeast(margin)))
            }
        }
    }
    Popup(
        popupPositionProvider = position,
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
        content = content,
    )
}

@Composable
internal fun HomeProjectFilterMenu(
    anchorBounds: Rect,
    selected: ProjectSessionStatusFilter,
    onDismiss: () -> Unit,
    onSelect: (ProjectSessionStatusFilter) -> Unit,
) {
    val colors = LocalAAColors.current
    HomeProjectAnchoredPopup(anchorBounds, onDismiss) {
        Column(
            modifier = Modifier
                .width(252.dp)
                .shadow(24.dp, RoundedCornerShape(22.dp))
                .clip(RoundedCornerShape(22.dp))
                .background(colors.raisedSurface)
                .border(1.dp, colors.border, RoundedCornerShape(22.dp))
                .padding(vertical = 8.dp),
        ) {
            Text(
                stringResource(R.string.home_project_session_status),
                modifier = Modifier.padding(horizontal = 18.dp, vertical = 8.dp),
                color = colors.faint,
                fontSize = 12.sp,
            )
            ProjectSessionStatusFilter.entries.forEach { status ->
                val label = when (status) {
                    ProjectSessionStatusFilter.Active -> R.string.home_project_filter_active
                    ProjectSessionStatusFilter.Archived -> R.string.home_project_filter_archived
                    ProjectSessionStatusFilter.All -> R.string.home_project_filter_all
                }
                Row(
                    modifier = Modifier.fillMaxWidth().height(48.dp)
                        .selectable(selected = selected == status, role = Role.RadioButton) {
                            onSelect(status)
                            onDismiss()
                        }.padding(horizontal = 18.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(stringResource(label), modifier = Modifier.weight(1f), color = colors.ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    if (selected == status) Icon(Lucide.Check, contentDescription = null, tint = colors.ink, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}
