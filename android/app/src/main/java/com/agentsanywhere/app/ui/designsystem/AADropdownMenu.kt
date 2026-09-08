package com.agentsanywhere.app.ui.designsystem

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide
import kotlin.math.roundToInt

private val MenuShape = RoundedCornerShape(18.dp)
private val MenuWidth = 286.dp
private val MenuMaxHeight = 328.dp
private val MenuVerticalPadding = 14.dp
private val MenuGap = 4.dp

/** Place inside the selector's anchor Box. Selection and dismissal stay with the caller. */
@Composable
fun AADropdownMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = MenuWidth,
    maxHeight: Dp = MenuMaxHeight,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalAAColors.current
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismissRequest,
        offset = DpOffset(0.dp, MenuGap),
        shape = MenuShape,
        containerColor = if (colors.isDark) colors.subtle else colors.raisedSurface,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
        modifier = modifier.width(width).heightIn(max = maxHeight).menuSurface(colors),
    ) {
        // Material's menu already contributes 8 dp of vertical content padding.
        Column(Modifier.selectableGroup().padding(vertical = MenuVerticalPadding - 8.dp), content = content)
    }
}

/** Same selector style for triggers tracked with boundsInWindow, retaining lazy lists. */
@Composable
fun AAAnchoredDropdownMenu(
    anchorBounds: Rect,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = MenuWidth,
    maxHeight: Dp = MenuMaxHeight,
    content: LazyListScope.() -> Unit,
) {
    val colors = LocalAAColors.current
    AAAnchoredPopup(anchorBounds, onDismissRequest, gap = MenuGap) {
        LazyColumn(
            modifier = modifier.width(width).heightIn(max = maxHeight).menuSurface(colors).selectableGroup(),
            contentPadding = PaddingValues(vertical = MenuVerticalPadding),
            content = content,
        )
    }
}

@Composable
fun AADropdownMenuItem(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    supportingText: String? = null,
    supportingTextMaxLines: Int = 2,
) {
    val colors = LocalAAColors.current
    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    val focused by interactions.collectIsFocusedAsState()
    val textColor = colors.ink.copy(alpha = if (enabled) 1f else 0.42f)
    Row(
        modifier = modifier.fillMaxWidth().heightIn(min = 48.dp)
            .background(if (enabled && (pressed || focused)) colors.ink.copy(alpha = 0.07f) else Color.Transparent)
            .selectable(
                selected = selected,
                enabled = enabled,
                role = Role.RadioButton,
                interactionSource = interactions,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = textColor, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = text,
                color = textColor,
                fontSize = 14.sp,
                lineHeight = 19.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            supportingText?.takeIf(String::isNotBlank)?.let { description ->
                Text(
                    text = description,
                    color = colors.inkSoft.copy(alpha = if (enabled) 0.72f else 0.42f),
                    fontSize = 11.sp,
                    lineHeight = 14.sp,
                    maxLines = supportingTextMaxLines,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (selected) Icon(Lucide.Check, contentDescription = null, tint = textColor, modifier = Modifier.size(18.dp))
        else Spacer(Modifier.size(18.dp))
    }
}

@Composable
fun AADropdownMenuLabel(text: String) {
    Text(
        text = text,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        color = LocalAAColors.current.inkSoft.copy(alpha = 0.72f),
        fontSize = 12.sp,
    )
}

private fun Modifier.menuSurface(colors: AgentsAnywhereColors): Modifier =
    clip(MenuShape)
        .background(if (colors.isDark) colors.subtle else colors.raisedSurface)
        .border(1.dp, if (colors.isDark) Color.Transparent else colors.border, MenuShape)

/** Window positioning shared with existing project action popups. */
@Composable
internal fun AAAnchoredPopup(
    anchorBounds: Rect,
    onDismissRequest: () -> Unit,
    gap: Dp = 6.dp,
    content: @Composable () -> Unit,
) {
    val density = LocalDensity.current
    val gapPx = with(density) { gap.roundToPx() }
    val margin = with(density) { 12.dp.roundToPx() }
    val position = remember(anchorBounds, gapPx, margin) {
        object : PopupPositionProvider {
            override fun calculatePosition(
                anchorBounds: IntRect,
                windowSize: IntSize,
                layoutDirection: LayoutDirection,
                popupContentSize: IntSize,
            ): IntOffset = menuOffset(windowSize, popupContentSize)

            private fun menuOffset(windowSize: IntSize, size: IntSize): IntOffset {
                val x = (anchorBounds.right.roundToInt() - size.width)
                    .coerceIn(margin, (windowSize.width - size.width - margin).coerceAtLeast(margin))
                val below = anchorBounds.bottom.roundToInt() + gapPx
                val y = if (below + size.height + margin <= windowSize.height) below
                    else anchorBounds.top.roundToInt() - size.height - gapPx
                return IntOffset(x, y.coerceIn(margin, (windowSize.height - size.height - margin).coerceAtLeast(margin)))
            }
        }
    }
    Popup(
        popupPositionProvider = position,
        onDismissRequest = onDismissRequest,
        properties = PopupProperties(focusable = true),
        content = content,
    )
}
