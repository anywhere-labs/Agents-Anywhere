package dev.agentsanywhere.v3poc.design

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/** One row of an iOS menu: title on the left, symbol on the right; `divider` starts a new group above it. */
data class MenuItem(val title: String, val symbol: String? = null, val destructive: Boolean = false, val divider: Boolean = false, val action: () -> Unit)

/** A menu request: items and the anchor (root coordinates, px) it opens from. */
class MenuRequest(val items: List<MenuItem>, val anchor: Rect, val alignEnd: Boolean = false)

/**
 * iOS context menu / `Menu` popover: rounded glass card (22 dp corners, 250 dp wide), 44 dp rows, symbols on the
 * right, group separators, scaling in from the anchor. Tapping outside or Back closes it.
 */
@Composable
fun AAMenuHost(request: MenuRequest?, onDismiss: () -> Unit) {
    var current by remember { mutableStateOf<MenuRequest?>(null) }
    val appear = remember { Animatable(0f) }
    LaunchedEffect(request) {
        if (request != null) { current = request; appear.snapTo(0f); appear.animateTo(1f, iosSpring(0.32f, 0.8f)) }
        else if (current != null) { appear.animateTo(0f, iosSpring(0.2f)); current = null }
    }
    val menu = current ?: return
    RegisterOverlay()
    BackHandler { onDismiss() }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val density = LocalDensity.current
        val screenW = with(density) { maxWidth.toPx() }
        val screenH = with(density) { maxHeight.toPx() }
        val width = with(density) { AAMetrics.menuWidth.toPx() }
        val rowH = with(density) { AAMetrics.menuRowHeight.toPx() }
        val height = menu.items.size * rowH + menu.items.count { it.divider } * with(density) { 8.dp.toPx() }
        val margin = with(density) { 12.dp.toPx() }
        val x = (if (menu.alignEnd) menu.anchor.right - width else menu.anchor.left).coerceIn(margin, screenW - width - margin)
        val below = menu.anchor.bottom + with(density) { 8.dp.toPx() }
        val opensUp = below + height > screenH - margin * 3
        val y = if (opensUp) (menu.anchor.top - height - with(density) { 8.dp.toPx() }).coerceAtLeast(margin) else below
        Box(Modifier.fillMaxSize().clickable(remember { MutableInteractionSource() }, null) { onDismiss() }
            .graphicsLayer { alpha = appear.value }.background(AA.colors.sheetScrim.copy(alpha = AA_MENU_DIM)))
        Column(
            Modifier
                .offset { IntOffset(x.roundToInt(), y.roundToInt()) }
                .width(AAMetrics.menuWidth)
                .graphicsLayer {
                    val p = appear.value
                    alpha = p.coerceIn(0f, 1f)
                    scaleX = 0.6f + 0.4f * p; scaleY = 0.6f + 0.4f * p
                    transformOrigin = TransformOrigin(if (menu.alignEnd) 1f else 0f, if (opensUp) 1f else 0f)
                }
                .glass(continuousRect(AAMetrics.menuCornerRadius), GlassKind.Sheet),
        ) {
            for (item in menu.items) {
                if (item.divider) Box(Modifier.fillMaxWidth().height(8.dp).background(AA.colors.separator.copy(alpha = 0.12f)))
                val color = if (item.destructive) AA.colors.red else AA.colors.label
                Row(
                    Modifier.fillMaxWidth().height(AAMetrics.menuRowHeight)
                        .pressable(Press.None) { onDismiss(); item.action() }
                        .padding(horizontal = AAMetrics.menuRowPaddingHorizontal),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AAText(item.title, Modifier.weight(1f), font = AAFonts.body, color = color, maxLines = 1)
                    Spacer(Modifier.width(12.dp))
                    item.symbol?.let { AASymbol(it, size = AAMetrics.menuIcon, tint = color) }
                }
            }
        }
    }
}

private const val AA_MENU_DIM = 0.35f

@Suppress("unused")
private fun Modifier.menuPadding() = padding(0.dp)
